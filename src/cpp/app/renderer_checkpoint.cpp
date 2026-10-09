#include <app/RendererCheckpoint.h>
#include <buv/Density.h>
#include <doctest.h>

#include <algorithm>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <string>
#include <vector>
#include <unistd.h>

namespace {
struct TempCheckpoint {
    std::filesystem::path dir;
    TempCheckpoint() {
        auto s=(std::filesystem::temp_directory_path()/"buv-renderer-test-XXXXXX").string();
        std::vector<char> p(s.begin(),s.end());p.push_back('\0');
        auto result=::mkdtemp(p.data());if (!result) throw std::runtime_error("mkdtemp failed");dir=result;
    }
    ~TempCheckpoint() { std::error_code ec;std::filesystem::remove_all(dir,ec); }
    auto path() const -> std::filesystem::path { return dir/"snapshot.bin"; }
};
auto hex(buv::RendererCheckpointHash const& h) -> std::string {
    std::string s;for(auto b:h){s+="0123456789abcdef"[b>>4];s+="0123456789abcdef"[b&15];}return s;
}
auto cfg(uint32_t start=26) -> buv::Cfg {
    buv::Cfg c;c.imageWidth=80;c.imageHeight=32;c.graphRect={0,2,72,28};
    c.minSatoshi=1;c.maxSatoshi=10'000'000'000'000LL;c.xAxisMode="normalizedGeometric";
    c.epochBlocks=10;c.epochRatio=0.5;c.epochTransitionBlocks=3;
    c.startShowAtBlockHeight=start;c.skipBlocks=0;c.amountWeightedDensity=true;
    c.colorBackgroundRGB={0,0,0};c.colorHighlightRGB={255,255,255};return c;
}
auto binding(uint32_t h=26) -> buv::RendererCheckpointBinding {
    return {h,1000+h*32,buv::rendererCheckpointHash("previous encoded BLK record",27)};
}
void changes(buv::Density& d,uint32_t h) {
    d.change(h,700'000'003);d.change(h,800'000'007);d.change(h,1);
    if (h>=4) d.change(h-4,-700'000'003);
    if (h>=8) d.change(h-8,-800'000'007);
}
void replay(buv::Density& d,uint32_t first,uint32_t end) {
    for(auto h=first;h<end;++h) {d.begin_block(h);changes(d,h);d.end_block(h,[](uint8_t const*){});}
}
auto ledger(buv::Density const& d) -> std::map<uint64_t,uint64_t> {
    std::map<uint64_t,uint64_t> result;
    d.checkpointVisitLedger([&](uint64_t k,double w){uint64_t b;std::memcpy(&b,&w,8);result.emplace(k,b);});return result;
}
auto readBytes(std::filesystem::path const& p) -> std::vector<uint8_t> {
    std::ifstream f(p,std::ios::binary);return {std::istreambuf_iterator<char>(f),{}};
}
void writeBytes(std::filesystem::path const& p,std::vector<uint8_t> const& b) {
    std::ofstream f(p,std::ios::binary|std::ios::trunc);f.write(reinterpret_cast<char const*>(b.data()),static_cast<std::streamsize>(b.size()));
}
void put64(std::vector<uint8_t>& b,size_t at,uint64_t value) {
    for(size_t i=0;i<8;++i)b[at+i]=static_cast<uint8_t>(value>>(8*i));
}
void resign(std::vector<uint8_t>& b) {
    auto header=buv::rendererCheckpointHash(b.data(),120);std::copy(header.begin(),header.end(),b.begin()+120);
    auto all=buv::rendererCheckpointHash(b.data(),b.size()-32);std::copy(all.begin(),all.end(),b.end()-32);
}
}

TEST_CASE("renderer_checkpoint_sha256" * doctest::skip()) {
    CHECK(hex(buv::rendererCheckpointHash("",0))=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(hex(buv::rendererCheckpointHash("abc",3))=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    std::string boundary="abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    CHECK(hex(buv::rendererCheckpointHash(boundary.data(),boundary.size()))=="248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    std::string million(1'000'000,'a');
    CHECK(hex(buv::rendererCheckpointHash(million.data(),million.size()))=="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    TempCheckpoint t;std::vector<uint8_t> bytes(million.begin(),million.end());bytes.insert(bytes.begin(),3,'x');writeBytes(t.path(),bytes);
    CHECK(buv::rendererCheckpointHashFileRange(t.path(),3,million.size())==buv::rendererCheckpointHash(million.data(),million.size()));
    CHECK_THROWS(buv::rendererCheckpointHashFileRange(t.path(),3,million.size()+1));
}

TEST_CASE("renderer_checkpoint" * doctest::skip()) {
    TempCheckpoint t;
    auto c=cfg();auto b=binding();buv::Density original(c,80);replay(original,0,b.nextHeight);
    auto before=ledger(original);
    buv::saveRendererCheckpoint(t.path(),original,b);
    CHECK(ledger(original)==before); // saving is read-only, including exact f64 bits
    auto inspected=buv::readRendererCheckpointBinding(t.path());
    CHECK(inspected.nextHeight==b.nextHeight);CHECK(inspected.nextBlkOffset==b.nextBlkOffset);CHECK(inspected.previousRecordHash==b.previousRecordHash);
    auto good=readBytes(t.path());CHECK(good.size()==152+before.size()*16+32);
    buv::Density restored(c,90); // appended BLK length is deliberately not fingerprinted
    buv::loadRendererCheckpoint(t.path(),restored,b);CHECK(ledger(restored)==before);
    for(uint32_t h=b.nextHeight;h<46;++h) {
        std::vector<uint8_t> expected,actual;
        original.begin_block(h);restored.begin_block(h);changes(original,h);changes(restored,h);
        original.end_block(h,[&](uint8_t const* p){expected.assign(p,p+c.imageWidth*c.imageHeight*3);});
        restored.end_block(h,[&](uint8_t const* p){actual.assign(p,p+c.imageWidth*c.imageHeight*3);});
        CHECK(actual==expected);CHECK(ledger(restored)==ledger(original));
    }
    // Rolling save AFTER original visible start, then load BEFORE next range.
    auto rolling=binding(46);buv::saveRendererCheckpoint(t.path(),original,rolling);
    auto later=cfg(49);
    CHECK(buv::rendererCheckpointConfigFingerprint(later)==buv::rendererCheckpointConfigFingerprint(c));
    buv::Density freshLater(later,100),resumeLater(later,100);
    replay(freshLater,0,46);buv::loadRendererCheckpoint(t.path(),resumeLater,rolling);
    for(uint32_t h=46;h<56;++h) {
        std::vector<uint8_t> expected,actual;
        freshLater.begin_block(h);resumeLater.begin_block(h);changes(freshLater,h);changes(resumeLater,h);
        freshLater.end_block(h,[&](uint8_t const* p){expected.assign(p,p+later.imageWidth*later.imageHeight*3);});
        resumeLater.end_block(h,[&](uint8_t const* p){actual.assign(p,p+later.imageWidth*later.imageHeight*3);});
        CHECK(expected==actual);CHECK(ledger(freshLater)==ledger(resumeLater));
    }
    writeBytes(t.path(),good);
    buv::Density rejected(c,80);
    auto reject=[&](std::vector<uint8_t> const& damaged) {
        writeBytes(t.path(),damaged);CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),rejected,b));CHECK(rejected.checkpointLedgerSize()==0);
    };
    auto bad=good;bad[152+8]^=1;reject(bad); // plausible finite weight, bad integrity
    bad=good;bad.back()^=1;reject(bad);
    bad=good;bad[56]^=1;reject(bad);CHECK_THROWS(buv::readRendererCheckpointBinding(t.path()));
    bad=good;bad.pop_back();reject(bad);
    bad=good;bad.push_back(0);reject(bad);
    // Re-signed hostile inputs must fail semantic validation, not merely SHA.
    for(auto weightBits:{0ULL,0x7ff0000000000000ULL,0x7ff8000000000000ULL,0xbff0000000000000ULL}) {
        bad=good;put64(bad,160,weightBits);resign(bad);reject(bad);
    }
    bad=good;put64(bad,152,static_cast<uint64_t>(b.nextHeight)<<16U);resign(bad);reject(bad);
    bad=good;put64(bad,152,0);resign(bad);reject(bad); // y outside graph
    bad=good;std::copy(bad.begin()+152,bad.begin()+160,bad.begin()+168);resign(bad);reject(bad); // duplicate key
    bad=good;put64(bad,48,std::numeric_limits<uint64_t>::max());resign(bad);reject(bad);
    bad=good;put64(bad,40,999);resign(bad);reject(bad);
    writeBytes(t.path(),good);
    auto wrong=b;wrong.nextBlkOffset++;CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),rejected,wrong));
    wrong=b;wrong.previousRecordHash[0]^=1;CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),rejected,wrong));
    wrong=b;wrong.nextHeight++;CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),rejected,wrong));
    auto different=c;different.amountWeightedDensity=false;buv::Density mismatch(different,80);
    CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),mismatch,b));
    // Good load still succeeds after all rejected loads (no poisoned live state).
    buv::loadRendererCheckpoint(t.path(),rejected,b);CHECK(ledger(rejected)==before);
    CHECK_THROWS(buv::loadRendererCheckpoint(t.path(),rejected,b));
    auto invalid=c;invalid.xAxisMode="linear";CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    invalid=c;invalid.epochBlocks=0;CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    invalid=c;uint64_t nanBits=0x7ff8000000000000ULL;std::memcpy(&invalid.epochRatio,&nanBits,8);CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    invalid=c;invalid.graphRect.h=100;CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    invalid=c;invalid.imageHeight=65537;CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    invalid=c;invalid.minSatoshi=0;CHECK_THROWS(buv::rendererCheckpointConfigFingerprint(invalid));
    // Current active slide must not be saved, even if next C would settle it.
    auto slideCfg=cfg(0);buv::Density slide(slideCfg,80);replay(slide,0,22);
    auto intact=readBytes(t.path());CHECK_THROWS(buv::saveRendererCheckpoint(t.path(),slide,binding(22)));CHECK(readBytes(t.path())==intact);
    // Never turn known-incomplete replay state into an apparently clean resume.
    buv::Density incomplete(c,80);replay(incomplete,0,b.nextHeight);
    incomplete.change(0,-123'456'789); // this coin was never added
    CHECK_THROWS(buv::saveRendererCheckpoint(t.path(),incomplete,b));
    CHECK(readBytes(t.path())==intact);
}
