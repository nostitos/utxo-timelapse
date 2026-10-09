#include <app/RendererCheckpoint.h>
#include <buv/Density.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

namespace buv {
namespace {
[[noreturn]] void fail(char const* what) {
    throw std::runtime_error(std::string("renderer checkpoint: ") + what);
}

// FIPS 180-4 SHA-256; all arithmetic is unsigned, all encoded words big endian.
// The checkpoint itself uses little endian independently of the hash algorithm.
class Sha256 {
    std::array<uint32_t, 8> h{{0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,
                             0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U}};
    std::array<uint8_t, 64> block{};
    size_t used{};
    uint64_t bytes{};
    static auto rotr(uint32_t x, unsigned n) -> uint32_t { return (x >> n) | (x << (32U-n)); }
    void compress() {
        static constexpr uint32_t k[64] = {
            0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
            0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
            0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
            0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
            0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
            0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
            0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
            0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U};
        uint32_t w[64]{};
        for (size_t i=0;i<16;++i) for (size_t j=0;j<4;++j) w[i]=(w[i]<<8U)|block[i*4+j];
        for (size_t i=16;i<64;++i) {
            auto x=w[i-15], y=w[i-2];
            w[i]=w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>3U))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>10U));
        }
        auto a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],z=h[7];
        for (size_t i=0;i<64;++i) {
            auto t1=z+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i];
            auto t2=(rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c));
            z=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
        }
        h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=z;
    }
public:
    void add(void const* data, size_t n) {
        if (n > std::numeric_limits<uint64_t>::max()/8 - bytes) fail("SHA256 length overflow");
        bytes+=n;
        auto p=static_cast<uint8_t const*>(data);
        while (n) {
            auto take=std::min(n,block.size()-used);
            std::memcpy(block.data()+used,p,take);used+=take;p+=take;n-=take;
            if (used==block.size()) { compress();used=0; }
        }
    }
    auto finish() -> RendererCheckpointHash {
        auto bits=bytes*8;
        block[used++]=0x80;
        if (used>56) { std::fill(block.begin()+static_cast<std::ptrdiff_t>(used),block.end(),0);compress();used=0; }
        std::fill(block.begin()+static_cast<std::ptrdiff_t>(used),block.begin()+56,0);
        for (size_t i=0;i<8;++i) block[63-i]=static_cast<uint8_t>(bits>>(8*i));
        compress();
        RendererCheckpointHash result{};
        for (size_t i=0;i<8;++i) for (size_t j=0;j<4;++j) result[i*4+j]=static_cast<uint8_t>(h[i]>>(24-8*j));
        return result;
    }
};
static_assert(sizeof(double)==8 && std::numeric_limits<double>::is_iec559,"checkpoint needs IEEE754 binary64");
auto bits(double const& value) -> uint64_t { uint64_t n;std::memcpy(&n,&value,8);return n; }
auto real(uint64_t n) -> double { double value;std::memcpy(&value,&n,8);return value; }
auto le(uint64_t n) -> std::array<uint8_t,8> {
    std::array<uint8_t,8> b{};
    for (size_t i=0;i<8;++i) b[i]=static_cast<uint8_t>(n>>(8*i));
    return b;
}
using File=std::unique_ptr<FILE,decltype(&std::fclose)>;
auto openRead(std::filesystem::path const& p) -> File {
    File f(std::fopen(p.c_str(),"rb"),&std::fclose);
    if (!f) fail("cannot open input file");
    return f;
}
void read(FILE* f,void* p,size_t n) { if (std::fread(p,1,n,f)!=n) fail("truncated file or read error"); }
struct Input {
    FILE* f;
    Sha256 hash;
    void bytes(void* p,size_t n) { read(f,p,n);hash.add(p,n); }
    auto number() -> uint64_t {
        std::array<uint8_t,8> b{};bytes(b.data(),b.size());uint64_t n=0;
        for (size_t i=0;i<8;++i) n|=static_cast<uint64_t>(b[i])<<(8*i);
        return n;
    }
    void finish() {
        RendererCheckpointHash expected{};read(f,expected.data(),expected.size());
        if (hash.finish()!=expected) fail("SHA256 integrity mismatch");
        if (std::fgetc(f)!=EOF || std::ferror(f)) fail("trailing bytes or read error");
    }
};
struct Output {
    FILE* f;
    Sha256 hash;
    void bytes(void const* p,size_t n) {
        if (std::fwrite(p,1,n,f)!=n) fail("write error");
        hash.add(p,n);
    }
    void number(uint64_t n) { auto b=le(n);bytes(b.data(),b.size()); }
    void finish() {
        auto digest=hash.finish();
        if (std::fwrite(digest.data(),1,digest.size(),f)!=digest.size() || std::fflush(f)!=0 || ::fsync(::fileno(f))!=0)
            fail("checkpoint flush failed");
    }
};
void validateCfg(Cfg const& c) {
    if (c.xAxisMode!="normalizedGeometric") fail("only normalizedGeometric geometry supported");
    auto r=c.graphRect;
    // Validate IEEE bits without FP comparisons: -ffast-math may otherwise
    // infer finiteness and remove even a nearby exponent-bit check.
    volatile uint64_t ratioBits=bits(c.epochRatio);
    if (!c.imageWidth || !c.imageHeight || c.imageHeight>65536 || !r.w || !r.h ||
        r.x>=c.imageWidth || r.y>=c.imageHeight || r.w>c.imageWidth-r.x || r.h>c.imageHeight-r.y ||
        c.imageWidth>std::numeric_limits<size_t>::max()/c.imageHeight/3 ||
        !c.epochBlocks || ratioBits==0 || ratioBits>=0x3ff0000000000000ULL ||
        c.epochTransitionBlocks>c.epochBlocks ||
        (c.xAxisMode!="normalizedGeometric" && c.epochTransitionBlocks!=0) ||
        c.minSatoshi<=0 || c.maxSatoshi<=c.minSatoshi ||
        c.colorUpperValueLimit<=1 || c.whiteHotTailMinSatoshi<0 ||
        (c.compressLowSatoshi && c.maxSatoshi<=100) ||
        (c.compressTopSatoshi && (!c.compressLowSatoshi || c.maxSatoshi<10'000'000'000'000LL)))
        fail("invalid checkpoint configuration");

}
void validateBinding(RendererCheckpointBinding const& b) {
    if (!b.nextHeight || !b.nextBlkOffset ||
        std::all_of(b.previousRecordHash.begin(),b.previousRecordHash.end(),[](uint8_t x){return x==0;}))
        fail("missing BLK binding");
}
constexpr char magic[8]={'B','U','V','R','C','P','0','1'};
// All integers are u64 LE (including heights/version) to keep a fixed layout.
constexpr uint64_t headerContentBytes=8+6*8+32+32;
constexpr uint64_t headerBytes=headerContentBytes+32;
} // namespace

auto rendererCheckpointHash(void const* p,size_t n) -> RendererCheckpointHash {
    Sha256 hash;hash.add(p,n);return hash.finish();
}
auto rendererCheckpointHashFileRange(std::filesystem::path const& p,uint64_t offset,uint64_t size) -> RendererCheckpointHash {
    auto f=openRead(p);
    if (::fseeko(f.get(),0,SEEK_END)!=0) fail("file range seek failed");
    auto length=::ftello(f.get());
    if (length<0 || offset>static_cast<uint64_t>(length) || size>static_cast<uint64_t>(length)-offset) fail("file range outside input");
    if (offset>static_cast<uint64_t>(std::numeric_limits<off_t>::max()) ||
        ::fseeko(f.get(),static_cast<off_t>(offset),SEEK_SET)!=0) fail("invalid file range offset");
    Sha256 hash;std::array<uint8_t,65536> buffer{};
    while (size) { auto n=static_cast<size_t>(std::min<uint64_t>(size,buffer.size()));read(f.get(),buffer.data(),n);hash.add(buffer.data(),n);size-=n; }
    return hash.finish();
}
auto rendererCheckpointConfigFingerprint(Cfg const& c) -> RendererCheckpointHash {
    validateCfg(c);
    Sha256 h;
    auto number=[&](uint64_t n){auto b=le(n);h.add(b.data(),b.size());};
    auto string=[&](std::string const& s){number(s.size());h.add(s.data(),s.size());};
    // Versioned renderer semantics, not paths, encoder, RPC, output end, audio,
    // or total BLK length: appending blocks must not invalidate epoch geometry.
    string("UTXO Timelapse renderer checkpoint config v1");
    number(c.imageWidth);number(c.imageHeight);number(c.graphRect.x);number(c.graphRect.y);number(c.graphRect.w);number(c.graphRect.h);
    number(static_cast<uint64_t>(c.minSatoshi));number(static_cast<uint64_t>(c.maxSatoshi));
    string(c.xAxisMode);number(c.epochBlocks);number(bits(c.epochRatio));number(c.epochTransitionBlocks);
    number(c.compressLowSatoshi);number(c.compressTopSatoshi);number(c.amountWeightedDensity);number(c.coinjoinFilter);
    string(c.colorMap);number(c.colorUpperValueLimit);number(c.amountColorFloor);number(c.whiteHotTail);number(static_cast<uint64_t>(c.whiteHotTailMinSatoshi));
    h.add(c.colorBackgroundRGB.data(),3);h.add(c.colorHighlightRGB.data(),3);
    return h.finish();
}
void saveRendererCheckpoint(std::filesystem::path const& path,Density const& density,RendererCheckpointBinding const& b) {
    auto fingerprint=rendererCheckpointConfigFingerprint(density.checkpointConfig());
    validateBinding(b);density.checkpointValidateBoundary(b.nextHeight,false);
    std::vector<uint64_t> keys;keys.reserve(density.checkpointLedgerSize());
    density.checkpointVisitLedger([&](uint64_t key,double){keys.push_back(key);});
    std::sort(keys.begin(),keys.end());
    // mkstemp is exclusive, mode 0600, and same-directory rename is atomic.
    auto temp=path.string()+".tmp.XXXXXX";
    std::vector<char> name(temp.begin(),temp.end());name.push_back('\0');
    auto fd=::mkstemp(name.data());if (fd<0) fail("cannot create temporary checkpoint");
    File f(::fdopen(fd,"wb"),&std::fclose);
    if (!f) { ::close(fd);::unlink(name.data());fail("fdopen failed"); }
    try {
        Output out{f.get(),{}};
        out.bytes(magic,8);out.number(1);out.number(headerBytes);out.number(b.nextHeight);out.number(b.nextBlkOffset);
        out.number(density.getCurrentEpoch());out.number(keys.size());
        out.bytes(b.previousRecordHash.data(),32);out.bytes(fingerprint.data(),32);
        auto headerHasher=out.hash;auto headerDigest=headerHasher.finish();
        out.bytes(headerDigest.data(),headerDigest.size());
        for (auto key:keys) {
            auto weight=density.checkpointLedgerWeight(key);
            auto y=key&0xffffU;auto const& r=density.checkpointConfig().graphRect;
            if ((key>>16U)>=b.nextHeight || y<r.y || y-r.y>=r.h || bits(weight)==0 || bits(weight)>=0x7ff0000000000000ULL)
                fail("invalid ledger during save");
            out.number(key);out.number(bits(weight));
        }
        out.finish();
        auto raw=f.release();if (std::fclose(raw)!=0) fail("close failed");
        if (::rename(name.data(),path.c_str())!=0) fail("atomic rename failed");
    } catch (...) { ::unlink(name.data());throw; }
}
auto readRendererCheckpointBinding(std::filesystem::path const& path) -> RendererCheckpointBinding {
    auto f=openRead(path);Input in{f.get(),{}};
    char m[8];in.bytes(m,8);
    if (std::memcmp(m,magic,8)!=0 || in.number()!=1 || in.number()!=headerBytes) fail("unsupported header");
    auto height=in.number(), offset=in.number(), epoch=in.number(), count=in.number();
    if (height>std::numeric_limits<uint32_t>::max() || epoch>std::numeric_limits<uint32_t>::max() ||
        count>(std::numeric_limits<uint64_t>::max()-headerBytes-32)/16) fail("invalid header fields");
    RendererCheckpointBinding binding{static_cast<uint32_t>(height),offset,{}};
    RendererCheckpointHash config{},digest{};
    in.bytes(binding.previousRecordHash.data(),32);in.bytes(config.data(),32);
    auto headerHasher=in.hash;in.bytes(digest.data(),32);
    if (headerHasher.finish()!=digest) fail("header checksum mismatch");
    validateBinding(binding);
    if (::fseeko(f.get(),0,SEEK_END)!=0) fail("seek failed");
    auto length=::ftello(f.get());
    if (length<0 || static_cast<uint64_t>(length)!=headerBytes+count*16+32) fail("invalid checkpoint length");
    return binding;
}
void loadRendererCheckpoint(std::filesystem::path const& path,Density& density,RendererCheckpointBinding const& b) {
    auto fingerprint=rendererCheckpointConfigFingerprint(density.checkpointConfig());
    validateBinding(b);density.checkpointValidateBoundary(b.nextHeight,true);
    auto f=openRead(path);Input in{f.get(),{}};
    char m[8];in.bytes(m,8);
    if (std::memcmp(m,magic,8)!=0 || in.number()!=1 || in.number()!=headerBytes) fail("unsupported header");
    if (in.number()!=b.nextHeight || in.number()!=b.nextBlkOffset) fail("BLK height/offset mismatch");
    auto epoch=in.number(), count=in.number();
    RendererCheckpointHash previous{},savedConfig{};in.bytes(previous.data(),32);in.bytes(savedConfig.data(),32);
    auto headerHasher=in.hash;RendererCheckpointHash headerDigest{};in.bytes(headerDigest.data(),32);
    if (headerDigest!=headerHasher.finish()) fail("header checksum mismatch");
    if (previous!=b.previousRecordHash) fail("BLK record hash mismatch");
    if (savedConfig!=fingerprint) fail("configuration fingerprint mismatch");
    if (epoch!=(b.nextHeight-1)/density.checkpointConfig().epochBlocks) fail("epoch mismatch");
    if (count>std::numeric_limits<size_t>::max() || count>(std::numeric_limits<uint64_t>::max()-headerBytes-32)/16 ||
        count>static_cast<uint64_t>(b.nextHeight)*density.checkpointConfig().graphRect.h)
        fail("invalid ledger count");
    // Check length on the same open descriptor, not a path that could be swapped.
    if (::fseeko(f.get(),0,SEEK_END)!=0) fail("seek failed");
    auto length=::ftello(f.get());
    if (length<0 || static_cast<uint64_t>(length)!=headerBytes+count*16+32 ||
        ::fseeko(f.get(),static_cast<off_t>(headerBytes),SEEK_SET)!=0) fail("invalid checkpoint length");
    density.checkpointImportLedger(static_cast<size_t>(count),b.nextHeight,static_cast<uint32_t>(epoch),[&] {
        auto key=in.number();auto weightBits=in.number();
        if (weightBits==0 || weightBits>=0x7ff0000000000000ULL) fail("invalid ledger weight");
        return std::make_pair(key,real(weightBits));
    },[&]{in.finish();});
}
} // namespace buv
