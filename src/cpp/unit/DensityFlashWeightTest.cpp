#include <buv/Density.h>

#include <doctest/doctest.h>

TEST_CASE("whale flash weight uses actual value without a per-UTXO floor") {
    constexpr auto satoshiPerBtc = int64_t{100'000'000};

    auto const dustWeight = buv::Density::flashWeightForAmount(330);
    CHECK(dustWeight == doctest::Approx(0.00000066));
    CHECK(buv::Density::flashWeightForAmount(-330) == doctest::Approx(dustWeight));

    // Even one million 330-sat outputs total only 3.3 BTC, below the first
    // 25-BTC whale-star threshold (weight 5).
    CHECK(dustWeight * 1'000'000 < 5.0);

    CHECK(buv::Density::flashWeightForAmount(25 * satoshiPerBtc) == doctest::Approx(5.0));
    CHECK(buv::Density::flashWeightForAmount(10'000 * satoshiPerBtc) == doctest::Approx(2'000.0));
}
