#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace buv {

// Laser Rust Removal Aesthetic Audio Synthesizer
//
// Design principles:
// - Impulse/noise-based, not tonal
// - Bandpass-filtered white noise bursts
// - Fast envelopes (<5ms attack, 20-80ms decay)
// - Silence when idle (no continuous drone)
// - Age determines frequency band (old = low rumble, young = high sizzle)
// - Pattern size determines burst density
// - Max concurrent sounds prevents accumulation
//
// Target sound: "Amplified Geiger counter with pink noise coloration"

// Active impulse event
struct ImpulseEvent {
    int band;               // Filter band index (0-4)
    float amplitude;        // Current amplitude
    float attackRate;       // Attack increment per sample
    float decayRate;        // Decay decrement per sample
    int attackSamples;      // Remaining attack samples
    int decaySamples;       // Remaining decay samples
    bool inAttack;          // Currently in attack phase
};

// Biquad filter state
struct BiquadState {
    float z1 = 0.0f;
    float z2 = 0.0f;
};

// Biquad bandpass filter coefficients
struct BandpassCoeffs {
    float b0, b1, b2;
    float a1, a2;
};

// Pattern cluster detected in spending events
struct PatternCluster {
    uint32_t minAge;
    uint32_t maxAge;
    uint32_t creationBlock;
    int64_t totalSatoshi;
    int count;
    float coherence;
};

// Main audio synthesizer - impulse/noise based
class AudioSynthesizer {
public:
    static constexpr float TWO_PI = 6.28318530718f;
    static constexpr int NUM_BANDS = 5;
    static constexpr int MAX_IMPULSES = 64;

    // Band definitions: center freq, Q, min age, max age
    // Sub (ancient): 80 Hz, deep rumble
    // Low: 200 Hz, bass
    // Mid: 1.5 kHz, core click
    // High: 4 kHz, bright pop
    // Air: 12 kHz, sizzle

    explicit AudioSynthesizer(const std::string& outputFile, float sampleRate = 48000.0f,
                               int samplesPerBlock = 800)
        : m_sampleRate(sampleRate)
        , m_samplesPerBlock(samplesPerBlock)
        , m_blockBuffer(samplesPerBlock, 0.0f)
        , m_noiseBuffer(samplesPerBlock, 0.0f)
        , m_lfsr(0xACE1u) {

        m_file.open(outputFile, std::ios::binary);
        m_activeImpulses.reserve(MAX_IMPULSES);

        // Initialize filter coefficients for each band
        initBandpassFilters();

        // Initialize filter states for each band
        for (int i = 0; i < NUM_BANDS; i++) {
            m_filterStates[i] = BiquadState{0.0f, 0.0f};
        }
    }

    ~AudioSynthesizer() {
        if (m_file.is_open()) {
            m_file.close();
        }
    }

    void addSpend(uint32_t currentBlock, uint32_t creationBlock, int64_t satoshi) {
        if (satoshi >= 0) return;

        SpendEvent event;
        event.currentBlock = currentBlock;
        event.creationBlock = creationBlock;
        event.age = currentBlock - creationBlock;
        event.satoshi = -satoshi;
        m_currentBlockSpends.push_back(event);
    }

    void endBlock() {
        // Clear buffer
        std::fill(m_blockBuffer.begin(), m_blockBuffer.end(), 0.0f);

        // Detect patterns and create impulses
        if (!m_currentBlockSpends.empty()) {
            auto patterns = detectPatterns();
            for (const auto& pattern : patterns) {
                createImpulsesForPattern(pattern);
            }
        }

        // Generate white noise for this block
        generateNoiseBuffer();

        // Render all active impulses through their filters
        renderImpulses();

        // Apply soft limiter with headroom
        for (float& sample : m_blockBuffer) {
            // Soft saturation - preserves dynamics while preventing clipping
            sample = std::tanh(sample * 0.6f) * 1.4f;
        }

        // Write output
        if (m_file.is_open()) {
            m_file.write(reinterpret_cast<const char*>(m_blockBuffer.data()),
                        m_blockBuffer.size() * sizeof(float));
        }

        // Clear for next block
        m_currentBlockSpends.clear();

        // Remove dead impulses
        m_activeImpulses.erase(
            std::remove_if(m_activeImpulses.begin(), m_activeImpulses.end(),
                          [](const ImpulseEvent& imp) {
                              return !imp.inAttack && imp.decaySamples <= 0;
                          }),
            m_activeImpulses.end()
        );
    }

private:
    struct SpendEvent {
        uint32_t currentBlock;
        uint32_t creationBlock;
        uint32_t age;
        int64_t satoshi;
    };

    // Initialize bandpass filter coefficients
    void initBandpassFilters() {
        // Band 0: Sub (ancient 100k+) - 80 Hz, Q=2.0
        m_bandCoeffs[0] = computeBandpass(80.0f, 2.0f);

        // Band 1: Low (10k-100k) - 200 Hz, Q=1.5
        m_bandCoeffs[1] = computeBandpass(200.0f, 1.5f);

        // Band 2: Mid (1k-10k) - 1500 Hz, Q=1.0
        m_bandCoeffs[2] = computeBandpass(1500.0f, 1.0f);

        // Band 3: High (100-1k) - 4000 Hz, Q=1.0
        m_bandCoeffs[3] = computeBandpass(4000.0f, 1.0f);

        // Band 4: Air (0-100) - 12000 Hz, Q=0.8
        m_bandCoeffs[4] = computeBandpass(12000.0f, 0.8f);
    }

    // Compute biquad bandpass coefficients (RBJ Audio EQ Cookbook)
    BandpassCoeffs computeBandpass(float freq, float Q) {
        BandpassCoeffs c;
        float omega = TWO_PI * freq / m_sampleRate;
        float sinOmega = std::sin(omega);
        float cosOmega = std::cos(omega);
        float alpha = sinOmega / (2.0f * Q);

        float a0 = 1.0f + alpha;

        c.b0 = alpha / a0;
        c.b1 = 0.0f;
        c.b2 = -alpha / a0;
        c.a1 = (-2.0f * cosOmega) / a0;
        c.a2 = (1.0f - alpha) / a0;

        return c;
    }

    // Process sample through biquad filter (Direct Form II Transposed)
    float processBiquad(float input, const BandpassCoeffs& c, BiquadState& s) {
        float output = c.b0 * input + s.z1;
        s.z1 = c.b1 * input - c.a1 * output + s.z2;
        s.z2 = c.b2 * input - c.a2 * output;
        return output;
    }

    // LFSR noise generator (fast, good enough for audio)
    float generateNoiseSample() {
        m_lfsr ^= m_lfsr >> 7;
        m_lfsr ^= m_lfsr << 9;
        m_lfsr ^= m_lfsr >> 13;
        return (static_cast<float>(m_lfsr) / static_cast<float>(UINT32_MAX)) * 2.0f - 1.0f;
    }

    // Generate noise buffer for this block
    void generateNoiseBuffer() {
        for (int i = 0; i < m_samplesPerBlock; i++) {
            m_noiseBuffer[i] = generateNoiseSample();
        }
    }

    // Detect patterns: groups of spends with similar creation blocks
    std::vector<PatternCluster> detectPatterns() {
        std::vector<PatternCluster> patterns;

        if (m_currentBlockSpends.empty()) return patterns;

        // Sort by creation block to find clusters
        auto spends = m_currentBlockSpends;  // Copy
        std::sort(spends.begin(), spends.end(),
                  [](const SpendEvent& a, const SpendEvent& b) {
                      return a.creationBlock < b.creationBlock;
                  });

        // Cluster spends with same or very close creation blocks
        PatternCluster current;
        current.creationBlock = spends[0].creationBlock;
        current.minAge = spends[0].age;
        current.maxAge = spends[0].age;
        current.totalSatoshi = spends[0].satoshi;
        current.count = 1;

        for (size_t i = 1; i < spends.size(); i++) {
            // Same cluster if creation blocks are within 10 of each other
            if (spends[i].creationBlock <= current.creationBlock + 10) {
                current.maxAge = std::max(current.maxAge, spends[i].age);
                current.minAge = std::min(current.minAge, spends[i].age);
                current.totalSatoshi += spends[i].satoshi;
                current.count++;
            } else {
                // Finish current cluster
                current.coherence = calculateCoherence(current);
                patterns.push_back(current);

                // Start new cluster
                current.creationBlock = spends[i].creationBlock;
                current.minAge = spends[i].age;
                current.maxAge = spends[i].age;
                current.totalSatoshi = spends[i].satoshi;
                current.count = 1;
            }
        }

        // Don't forget last cluster
        current.coherence = calculateCoherence(current);
        patterns.push_back(current);

        return patterns;
    }

    float calculateCoherence(const PatternCluster& cluster) {
        if (cluster.count <= 1) return 0.0f;
        float countFactor = std::min(1.0f, std::log2(cluster.count + 1.0f) / 5.0f);
        float ageTightness = 1.0f / (1.0f + (cluster.maxAge - cluster.minAge) / 1000.0f);
        return countFactor * ageTightness;
    }

    // Map age to frequency band
    int ageToBand(uint32_t age) {
        if (age >= 100000) return 0;  // Sub (ancient) - heavy scale
        if (age >= 10000) return 1;   // Low - bass ablation
        if (age >= 1000) return 2;    // Mid - core click
        if (age >= 100) return 3;     // High - bright pop
        return 4;                      // Air - light rust sizzle
    }

    // Create impulses for a pattern
    void createImpulsesForPattern(const PatternCluster& pattern) {
        // Limit active impulses
        if (m_activeImpulses.size() >= MAX_IMPULSES) {
            // Remove quietest impulse
            auto quietest = std::min_element(m_activeImpulses.begin(), m_activeImpulses.end(),
                [](const ImpulseEvent& a, const ImpulseEvent& b) {
                    return a.amplitude < b.amplitude;
                });
            if (quietest != m_activeImpulses.end()) {
                m_activeImpulses.erase(quietest);
            }
        }

        uint32_t avgAge = (pattern.minAge + pattern.maxAge) / 2;
        int band = ageToBand(avgAge);

        // Calculate amplitude based on satoshi value (log scale)
        float satoshiAmp = std::log10(static_cast<float>(pattern.totalSatoshi) + 1.0f) / 12.0f;

        // Base amplitude from pattern count
        float countAmp = std::min(1.0f, std::log2(pattern.count + 1.0f) / 6.0f);

        float baseAmplitude = std::min(0.9f, (satoshiAmp + countAmp) * 0.6f);

        // Ancient (100k+) minimum 0.4 amplitude (always perceptible)
        if (avgAge >= 100000) {
            baseAmplitude = std::max(baseAmplitude, 0.4f);
        } else if (avgAge >= 10000) {
            baseAmplitude = std::max(baseAmplitude, 0.2f);
        }

        // Coherent patterns get amplitude boost
        if (pattern.coherence > 0.3f) {
            baseAmplitude *= 1.0f + pattern.coherence * 0.5f;
        }
        baseAmplitude = std::min(baseAmplitude, 1.0f);

        // Calculate number of impulses based on pattern size
        // Single UTXO: 1 impulse
        // Pattern of 5-10: 3-5 impulses
        // Pattern of 50+: up to 8 impulses
        int numImpulses = 1;
        if (pattern.count >= 50) {
            numImpulses = 8;
        } else if (pattern.count >= 10) {
            numImpulses = std::min(8, static_cast<int>(std::sqrt(pattern.count)));
        } else if (pattern.count >= 2) {
            numImpulses = std::min(5, (pattern.count + 1) / 2);
        }

        // Spread impulses across the block buffer
        int spacing = m_samplesPerBlock / (numImpulses + 1);

        for (int i = 0; i < numImpulses; i++) {
            if (m_activeImpulses.size() >= MAX_IMPULSES) break;

            ImpulseEvent imp;
            imp.band = band;

            // Vary amplitude slightly for each impulse in burst
            float ampVariation = 0.8f + 0.4f * (generateNoiseSample() * 0.5f + 0.5f);
            imp.amplitude = 0.0f;  // Start at 0, ramp up during attack
            float targetAmplitude = baseAmplitude * ampVariation;

            // Fast attack: <2ms = ~96 samples at 48kHz
            int attackSamples = static_cast<int>(0.002f * m_sampleRate);
            imp.attackSamples = attackSamples;
            imp.attackRate = targetAmplitude / attackSamples;
            imp.inAttack = true;

            // Decay: 20-80ms based on band (lower = longer)
            // Ancient (band 0): 80ms
            // Air (band 4): 20ms
            float decayMs = 80.0f - band * 15.0f;
            int decaySamples = static_cast<int>(decayMs * 0.001f * m_sampleRate);
            imp.decaySamples = decaySamples;
            imp.decayRate = targetAmplitude / decaySamples;

            // Offset start time for burst effect
            imp.attackSamples += i * spacing;

            m_activeImpulses.push_back(imp);
        }
    }

    // Render all active impulses
    void renderImpulses() {
        // Per-band accumulators
        std::vector<float> bandBuffers[NUM_BANDS];
        for (int b = 0; b < NUM_BANDS; b++) {
            bandBuffers[b].resize(m_samplesPerBlock, 0.0f);
        }

        // Process each impulse's envelope and accumulate to band buffers
        for (auto& imp : m_activeImpulses) {
            for (int i = 0; i < m_samplesPerBlock; i++) {
                if (imp.attackSamples > 0) {
                    // Waiting to start (staggered burst)
                    imp.attackSamples--;
                    continue;
                }

                float env = imp.amplitude;

                if (imp.inAttack) {
                    imp.amplitude += imp.attackRate;
                    if (imp.attackSamples <= 0) {
                        imp.inAttack = false;
                    }
                } else {
                    imp.amplitude -= imp.decayRate;
                    imp.decaySamples--;
                    if (imp.amplitude < 0.0f) {
                        imp.amplitude = 0.0f;
                        imp.decaySamples = 0;
                    }
                }

                // Modulate noise with envelope
                bandBuffers[imp.band][i] += m_noiseBuffer[i] * env;
            }
        }

        // Filter each band and sum to output
        for (int b = 0; b < NUM_BANDS; b++) {
            for (int i = 0; i < m_samplesPerBlock; i++) {
                float filtered = processBiquad(bandBuffers[b][i], m_bandCoeffs[b], m_filterStates[b]);
                m_blockBuffer[i] += filtered;
            }
        }
    }

    // File output
    std::ofstream m_file;
    float m_sampleRate;
    int m_samplesPerBlock;
    std::vector<float> m_blockBuffer;
    std::vector<float> m_noiseBuffer;

    // Noise generator state
    uint32_t m_lfsr;

    // Filter coefficients and states for each band
    BandpassCoeffs m_bandCoeffs[NUM_BANDS];
    BiquadState m_filterStates[NUM_BANDS];

    // Event tracking
    std::vector<SpendEvent> m_currentBlockSpends;

    // Active impulses
    std::vector<ImpulseEvent> m_activeImpulses;
};

} // namespace buv
