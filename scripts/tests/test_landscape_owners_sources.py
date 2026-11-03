#!/usr/bin/env python3
"""Source adapters: one test per parser on a trimmed layout of its real source (example addresses
replace the real ones), plus fetching, archiving, reuse and the registry."""
import csv
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import address_coverage_labels as labels  # noqa: E402
import landscape_owners_sources as sources  # noqa: E402

A = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"          # Bitcoin wiki P2PKH example
B = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"          # Bitcoin wiki P2SH example
C = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"  # BIP173 P2WPKH
D = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"  # BIP173 P2WSH
E = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"  # BIP350 P2TR
G = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"          # genesis output, a valid legacy address


def source(**changes):
    return {**dict(id="test", entity="Binance", evidence_type="service_disclosure", license="not stated",
                   landing="https://example.com", status="active", cadence="snapshot", options={}), **changes}


def parse(parser, path, **changes):
    ctx = sources.Context(source(**changes), dict(url="https://example.com/file", local_path=path.name), "2026-01-02",
                          frozenset({"KuCoin", "Binance"}))
    sources.PARSERS[parser](path, ctx, {})
    return ctx


def addresses(ctx):
    return sorted({row["address"] for row in ctx.rows})


def xlsx(path, rows):
    """A minimal workbook with inline strings, as written by spreadsheet tools."""
    cells = "".join(
        f'<row r="{number}">' + "".join(f'<c r="{chr(65 + column)}{number}" t="inlineStr"><is><t>{value}</t></is></c>'
                                       for column, value in enumerate(row) if value != "") + "</row>"
        for number, row in enumerate(rows, 1))
    with zipfile.ZipFile(path, "w") as book:
        book.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/'
                      f'spreadsheetml/2006/main"><sheetData>{cells}</sheetData></worksheet>')


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.write_bytes(text.encode() if isinstance(text, str) else text)
        return path

    def test_okx_two_section_zip_drops_other_networks_and_rejects_bad_rows(self):
        text = "\n".join([
            "coin,snapshot height,amount", "BTC,961893,3000", "",
            "coin,Type,Network,Snapshot Height,address,amount,message,signature1,signature2,redeem script/ public key,EOA1,EOA2",
            f"BTC,Non Staking,BTC,961893,{A},1.5,I am an OKX address,sig,,,,",
            f"BTC,Native Staking,BTC,961893,{A},1.5,I am an OKX address,sig,,,,",
            f"BTC,Non Staking,Lightning,961893,02abcdef,1,,,,,,",
            f"BTC,Non Staking,BTC,961893,not_an_address,1,,,,,,",
            "ETH,Non Staking,ETH,24000000,0xabc,1,,,,,,"])
        path = self.root / "por_csv_2026081100_V6.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("okx_por.csv", text)
            archive.writestr("__MACOSX/._okx_por.csv", b"\0\x05")
        ctx = parse("por_csv", path, entity="OKX")
        self.assertEqual(addresses(ctx), [A])
        self.assertEqual(sorted(row["historical_note"].split(" (")[1].split(")")[0] for row in ctx.rows),
                         ["BTC height 961893, Native Staking", "BTC height 961893, Non Staking"])
        self.assertEqual(ctx.dropped, {"BTC on LIGHTNING": 1})
        self.assertEqual([row["value"] for row in ctx.rejected], ["not_an_address"])

    def test_binance_custodian_rows_are_excluded(self):
        path = self.write("PR01SEP26_HotCold.csv", "\n".join([
            "coin,network,address,balance,Height,Third party custodian name",
            f'BTC,BTC,{A},1.5,964957,""', f"BTC,BTC,{B},2.0,964957,Ceffu", f"BTC,BSC,{C},1,1,"]))
        ctx = parse("por_csv", path)
        self.assertEqual(addresses(ctx), [A])
        self.assertEqual([(row["address"], row["custodian"]) for row in ctx.excluded], [(B, "Ceffu")])
        self.assertEqual(ctx.dropped, {"BTC on BSC": 1})
        self.assertIn("hot/cold list", ctx.rows[0]["historical_note"])

    def test_htx_sections_without_a_network_column(self):
        path = self.write("huobi_por.csv", "\ufeff" + "\n".join([
            "coin,snapshot height,balance", "BTC(ALL),-,20003.96", "ThirdParty,_,1678.04", "",
            "coin,address,snapshot height,balance,message,signature",
            f"BTC,{A},969314,5862.70,huobi,sig", f"BTC-TRC20,TDToUxX8sH4z6moQpK3ZLAN24eupu2ivA4,86703812,1,-,-"]))
        ctx = parse("por_csv", path, entity="Huobi")
        self.assertEqual(addresses(ctx), [A])
        self.assertIn("no network column", ctx.rows[0]["historical_note"])
        self.assertEqual(ctx.dropped, {"BTC-TRC20 on its own network": 1})

    def test_coinex_spreadsheet_sections_owner_address_and_escrow(self):
        path = self.root / "CoinEx_Address_2026-9-14.xlsx"
        xlsx(path, [["Total"], ["coin", "block_height", "amount"], ["BTC", "966932", "1907"],
                    ["Hot Wallet"], ["coin", "address", "amount", "message", "signature"],
                    ["BTC", C, "96", "I am a CoinEx address", "sig"],
                    ["Cold Wallet"], ["coin", "address", "amount", "owner_address", "message", "signature"],
                    ["BTC", B, "1801", G, "I am a CoinEx address", "sig"],
                    ["Escrow"], ["coin", "address", "amount"], ["BTC", "-", "9.6"]])
        ctx = parse("por_csv", path, entity="CoinEx", options=dict(also_columns=["owner_address"]))
        self.assertEqual(addresses(ctx), sorted([B, C, G]))
        self.assertEqual(ctx.rejected, [])
        self.assertIn("cold wallet list", next(row for row in ctx.rows if row["address"] == B)["historical_note"])

    def test_bingx_spreadsheet_of_explorer_links(self):
        path = self.root / "bingXWalletAddress.xlsx"
        xlsx(path, [["coin", "network", "address"],
                    ["BTC", "Bitcoin", f"https://www.blockchain.com/explorer/addresses/btc/{C}"],
                    ["BTC", "Bitcoin", "https://suiscan.xyz/mainnet/account/0x1234"],
                    ["WBTC", "Ethereum", "https://etherscan.io/address/0xabc"]])
        ctx = parse("por_csv", path, entity="BingX")
        self.assertEqual(addresses(ctx), [C])
        self.assertEqual((len(ctx.rejected), ctx.dropped), (1, {"WBTC on ETHEREUM": 1}))

    def test_mexc_chinese_header_and_named_mainnet(self):
        path = self.write("MEXC_Merkle_Wallet_Address_20261009.csv", "\r\n".join([
            "资产,链,钱包地址,余额", "USDT,Ethereum(ERC20),0x1F73,250", f"BTC,Bitcoin(BTC),{C},4708.5", f"BTC,Bitcoin(BTC),{A},2883.8",
            "BTC,BNB Smart Chain(BEP20),0x2e8f,340.8", "BTC,Tron(TRC20),TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn,0.1", ""]))
        ctx = parse("por_csv", path, entity="MEXC", options=dict(header_names={"资产": "coin", "链": "network", "钱包地址": "address"},
                                                                 btc_networks=["Bitcoin(BTC)"]))
        self.assertEqual(addresses(ctx), sorted([A, C]))
        self.assertEqual(ctx.dropped, {"BTC on BNB SMART CHAIN(BEP20)": 1, "BTC on TRON(TRC20)": 1})

    def test_unknown_layouts_fail(self):
        cases = [("por_csv", "asset,chain,wallet\nBTC,BTC,x\n", {}),
                 ("json_list", '[{"wallet": "x"}]', dict(options=dict(path="", address_key="address", chain_key="blockchain",
                                                                         chain_values=["Bitcoin"], list="list"))),
                 ("text_wallets", "just one token\n", dict(options=dict(keep="^BTC\\s"))),
                 ("bitmex_reserves", "height:\n  1\nchain:\n  main\ntotal:\n  5\naddress:\n  - not a flow map\n", {}),
                 ("figshare_csv", "address,label\nx,y\n", {}),
                 ("html_anchors", "<a class='eth_link' href='https://x/0xabc'>x</a>", dict(options=dict(class_pattern="btc_", list="page"))),
                 ("js_items", 'coin:"ETH",items:[]', dict(options=dict(list="page")))]
        for parser, text, changes in cases:
            with self.subTest(parser=parser), self.assertRaisesRegex(ValueError, "unrecognised"):
                parse(parser, self.write(f"bad-{parser}.txt", text), **changes)

    def test_json_lists(self):
        backpack = self.write("wallets.json", json.dumps([dict(address=E, blockchain="Bitcoin"),
                                                          dict(address="43DbAvKxhXh1oSxkJSqGo", blockchain="Solana")]))
        ctx = parse("json_list", backpack, entity="Backpack", options=dict(
            path="", address_key="address", chain_key="blockchain", chain_values=["Bitcoin"], list="wallet list"))
        self.assertEqual(addresses(ctx), [E])
        bitstamp = self.write("page-002.json", json.dumps(dict(last_update=1793664007, wallets=dict(
            BTC=[dict(address=D, network="bitcoin"), dict(address=D, network="bitcoin"), dict(address="0xabc", network="ethereum")],
            ETH=[dict(address="0xdef", network="ethereum")]))))
        ctx = parse("json_list", bitstamp, entity="Bitstamp", options=dict(
            require=["wallets"], path="wallets.BTC", address_key="address", chain_key="network", chain_values=["bitcoin"],
            btc_only=True, observed_epoch="last_update", list="wallet transparency list"))
        self.assertEqual((addresses(ctx), ctx.observed, ctx.dropped), ([D], "2026-11-03", {"BTC on ethereum": 1}))

    def test_bitfinex_wallet_lines(self):
        path = self.write("wallets.txt", "\n".join([
            f"{A} - BTC hot wallet", f"{D} - BTC cold wallet", f"{G} - Bitcoin Cash hot wallet",
            "0x9ac376f749fff5b70d893f63b70ffa9e2f5012f7 - RBTC and RSK tokens (RIF) hot wallet",
            "VJLAYX5DZX1KuCBvAdR8ob6S9yLp (AMP ID: GA3fBygpY36J6tbg) - Blockstream Mining Note (BMN) hot wallet", ""]))
        ctx = parse("text_wallets", path, entity="Bitfinex", options=dict(keep="^BTC\\s"))
        self.assertEqual(addresses(ctx), sorted([A, D]))
        self.assertEqual(ctx.dropped, {"RBTC and RSK tokens (RIF) hot wallet": 1})

    def test_bitmex_reserves_must_add_up(self):
        entries = (f"  - {{'addr_type': 'sh', 'addr': '{B}', 'script': 'a914ab', 'balance': '40'}}\n"
                   f"  - {{'addr_type': 'wsh', 'addr': '{D}', 'script': '0020cd', 'balance': '60'}}\n")
        text = "height:\n  693062\nblockhash:\n  00ab\nchain:\n  main\nclaim:\n  m: 3\n  n: 4\ntotal:\n  {}\nkeys:\n  - 04aa\naddress:\n"
        ctx = parse("bitmex_reserves", self.write("reserves.yaml", text.format(100) + entries), entity="BitMEX")
        self.assertEqual(addresses(ctx), sorted([B, D]))
        self.assertIn("block 693062 (wsh", next(row for row in ctx.rows if row["address"] == D)["historical_note"])
        with self.assertRaisesRegex(ValueError, "truncated"):
            parse("bitmex_reserves", self.write("cut.yaml", text.format(100) + entries.splitlines(True)[0]), entity="BitMEX")

    def test_figshare_exchange_rows_of_registry_entities(self):
        path = self.write("addresses.csv", "\n".join([
            ",address,entity,category,source", f"0,{A},Kucoin,EXCHANGE,BitcoinTalk", f"1,{B},Mt.Gox,EXCHANGE,BitcoinTalk",
            f"2,{C},,GAMBLING,BitcoinTalk"]))
        ctx = parse("figshare_csv", path, entity=None, evidence_type="third_party_exact_tag")
        self.assertEqual([(row["address"], row["entity"], row["confidence"]) for row in ctx.rows],
                         [(A, "KuCoin", "third_party_reported")])
        self.assertEqual(ctx.skipped, {"exchange outside the registry: Mt.Gox": 1})

    def test_pages_tables_links_and_scripts(self):
        table = self.write("post.html", f"""<table><tr><td>Coin</td><td>Link</td></tr>
            <tr><td>BTC</td><td><a href="https://www.blockchain.com/explorer/addresses/btc/{C}">{C}</a></td></tr>
            <tr><td>BCH</td><td>{G}</td></tr><tr><td>btc</td><td>{A}<br>{B}</td></tr></table>""")
        ctx = parse("html_table", table, entity="CoinSwitch", options=dict(coin_pattern="^(btc|bitcoin)\\b", list="post"))
        self.assertEqual(addresses(ctx), sorted([A, B, C]))
        anchors = self.write("por.html", f'<a class="btc_cold_link_en w-inline-block" href="https://blockstream.info/address/{D}">'
                             f'Cold</a><a class="link-3" href="https://blockstream.info/address/{C}">Hot</a>'
                             f'<a class="eth_cold_link_en" href="https://etherscan.io/address/0xabc">x</a>')
        ctx = parse("html_anchors", anchors, entity="NBX", options=dict(class_pattern="btc_(cold|hot)_link", list="page"))
        self.assertEqual(addresses(ctx), [D])
        self.assertTrue(ctx.rows[0]["historical_note"].startswith("NBX page (btc_cold_link)."))
        ctx = parse("html_anchors", anchors, entity="NBX", options=dict(href_pattern="^https?://blockstream\\.info/address/", list="page"))
        self.assertEqual(addresses(ctx), sorted([C, D]))
        listing = self.write("list.html", f"<li><strong>Bitcoin (BTC):</strong><br> {B}<br>{A}<br></li>\n"
                             f"<li><strong>Litecoin (LTC):</strong><br>{G}</li>")
        ctx = parse("text_pattern", listing, entity="CEX.IO", options=dict(
            block="Bitcoin \\(BTC\\):(.*?)(?=\\n[^\\n]*\\([A-Z0-9]{2,6}\\):|\\Z)", list="list"))
        self.assertEqual(addresses(ctx), sorted([A, B]))
        notice = self.write("article.json", json.dumps(dict(article=dict(body=f"<p>BTC: {A}</p><p>EVM: 0xabc</p>"))))
        ctx = parse("text_pattern", notice, entity="WOO X", options=dict(json_path="article.body", pattern="^\\s*BTC:\\s*(\\S+)",
                                                                       list="notice", custodian="Cobo"))
        self.assertEqual((ctx.rows, [(row["address"], row["custodian"]) for row in ctx.excluded]), ([], [(A, "Cobo")]))
        bundle = self.write("chunk.js", f'x=[{{coin:"BTC",items:[{{address:"{C}",linkPrefix:"https://x/"}},{{address:"{B}"}}]}},'
                            f'{{coin:"ETH",items:[{{address:"0xabc"}}]}}]')
        self.assertEqual(addresses(parse("js_items", bundle, entity="Phemex", options=dict(list="page"))), sorted([B, C]))

    def test_typed_csv_with_and_without_header(self):
        options = dict(address_column="address", type_column="Address type", name_column="Wallet name",
                       keep_types=["Bitcoin-Legacy", "Bitcoin-Segwit"], fieldnames=["Wallet name", "Address type", "address"])
        first = self.write("old.csv", f"system-storage-prod,Bitcoin-Legacy,{A}\r\nsystem-doge,Doge,DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L\r\n")
        later = self.write("new.csv", f"Wallet name,Address type,address\r\nsystem-incoming-prod,Bitcoin-Segwit,{C}\r\n")
        self.assertEqual(addresses(parse("typed_csv", first, entity="SwissBorg", options=options)), [A])
        ctx = parse("typed_csv", later, entity="SwissBorg", options=options)
        self.assertEqual((addresses(ctx), "wallet 'system-incoming-prod'" in ctx.rows[0]["historical_note"]), ([C], True))

    def test_pdf_table_rejoins_wrapped_addresses(self):
        layout = "\n".join([
            "Verified Wallets", "Network                  Address", "Arbitrum                 0x00f3e09abe73aec2d6ad7b8820049b60ebc73f94",
            f"Bitcoin                  {B}", f"                         {D[:40]}", "Bitcoin", f"                         {D[40:]}",
            "Page 3 of 9", "Network                  Address", f"Merlin                   0x1e7cd241c07a24be28a501f156719aa6774676e0",
            f"Bitcoin                  {C[:20]}\u200b{C[20:]}"])
        with mock.patch.object(sources.subprocess, "check_output", lambda *args, **kwargs: layout):
            ctx = parse("pdf_table", self.write("report.pdf", b"%PDF"), entity="KuCoin",
                        options=dict(network="Bitcoin", list="report table"))
        self.assertEqual(addresses(ctx), sorted([B, C, D]))
        with mock.patch.object(sources.subprocess, "check_output", lambda *args, **kwargs: "no table here"), \
                self.assertRaisesRegex(ValueError, "unrecognised"):
            parse("pdf_table", self.write("other.pdf", b"%PDF"), entity="KuCoin", options=dict(network="Bitcoin", list="x"))

    def test_month_list(self):
        self.assertEqual(sources.month_list("2022-11", "2023-02"), ["202211", "202212", "202301", "202302"])


class DefiLlamaTests(unittest.TestCase):
    def test_bitcoin_references_and_wallet_pages(self):
        tokens = sources.js_tokens('''const config = { bitcoin: { owners: bitcoinAddressBook.okex }, bitcoincash: { owners: ["x"] } }
            // bitcoin: "commented"
            other = { bitcoin: "bitmex" }; inline = { bitcoin: { owners: ["a", 'b'] } }; late = { bitcoin: { tokens: [] } }''')
        self.assertEqual(sources.bitcoin_refs(tokens), [("book", "okex"), ("book", "bitmex"), ("list", ["a", "b"]),
                                                        ("unknown", "bitcoin configuration without owners")])
        kind = lambda link, site="https://www.okx.com", prefixes=(): sources.wallets_link_kind(link, site, prefixes)[0]  # noqa: E731
        self.assertEqual(kind("https://www.okx.com/proof-of-reserves"), "service_disclosure_via_aggregator")
        self.assertEqual(kind("https://x.com/okx/status/1", prefixes=["twitter.com/okx/"]), "service_disclosure_via_aggregator")
        self.assertEqual(kind("https://dune.com/21co/okx"), "third_party_exact_tag")
        self.assertEqual(kind(None), "third_party_exact_tag")
        self.assertIsNone(kind("https://intel.arkm.com/explorer/entity/okx"))
        self.assertEqual(sources.registered_domain("korbit.co.kr"), "korbit.co.kr")

    def test_pinned_adapters_resolve_through_the_address_book(self):
        files = {
            "projects/helper/bitcoin-book/index.js": f'''const imports = [["bitmex", "./bitmex.js"]];
                const lbank = ["{G}"];
                module.exports = {{ ...fetchers, lbank, okex: ["{A}", "{B}"], wbtc: async () => [],
                {", ".join(f'k{n}: ["{C}"]' for n in range(10))} }};''',
            "projects/helper/bitcoin-book/bitmex.js": f'module.exports = ["{D}"]',
            "cex/index.js": '''const configs = { 'mexc-cex': { bitcoin: "lbank" } }; const fileConfigs = [];''',
            "projects/okex/index.js": "const config = { bitcoin: { owners: bitcoinAddressBook.okex } }",
            "projects/bitmex/index.js": "const config = { bitcoin: { owners: bitcoinAddressBook.bitmex } }",
            "projects/arkm/index.js": f'const config = {{ bitcoin: {{ owners: ["{E}"] }} }}',
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "adapters"
            for name, text in files.items():
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text(text)
            git = lambda *args: subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)  # noqa: E731
            git("init", "-q")
            git("add", ".")
            git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "pinned")
            commit = git("rev-parse", "HEAD").stdout.strip()
            replies = {
                "https://api.llama.fi/cexs": json.dumps(dict(cexs=[
                    dict(name="OKX", slug="okx", url="https://www.okx.com", walletsLink="https://www.okx.com/proof-of-reserves"),
                    dict(name="Bitmex", slug="bitmex", url="https://www.bitmex.com", walletsLink="https://dune.com/x"),
                    dict(name="Arkham Exchange", slug="arkm", url="https://arkm.com", walletsLink="https://intel.arkm.com/x")])),
                "https://api.llama.fi/protocols": json.dumps([
                    dict(name="OKX", slug="okx", category="CEX", module="okex/index.js"),
                    dict(name="Bitmex", slug="bitmex", category="CEX", module="bitmex/index.js"),
                    dict(name="MEXC", slug="mexc", category="CEX", module="mexc-cex/index.js"),
                    dict(name="Arkham Exchange", slug="arkm", category="CEX", module="arkm/index.js"),
                    dict(name="Kraken", slug="kraken", category="CEX", module="dummy.js"),
                    dict(name="Uniswap", slug="uniswap", category="Dexs", module="uniswap/index.js")])}
            with mock.patch.object(sources, "http_get", fake_http(replies)):
                fetcher = sources.Fetcher(Path(tmp) / "out")
                contexts, enumeration = sources.run_defillama(source(entity=None, options=dict(
                    repository=str(repo), commit=commit, cexs="https://api.llama.fi/cexs",
                    protocols="https://api.llama.fi/protocols")), fetcher, {})
        rows = {(row["address"], row["entity"], row["evidence_type"]) for ctx in contexts for row in ctx.rows}
        self.assertEqual(rows, {(A, "OKX", "service_disclosure_via_aggregator"), (B, "OKX", "service_disclosure_via_aggregator"),
                                (D, "BitMEX", "third_party_exact_tag"), (G, "MEXC", "third_party_exact_tag")})
        self.assertEqual([row["address"] for ctx in contexts for row in ctx.excluded], [E])
        results = {item["name"]: item["result"] for item in enumeration[0]["adapters"]}
        self.assertEqual(results, {"OKX": "2 rows", "Bitmex": "1 rows", "MEXC": "1 rows", "Arkham Exchange": "excluded",
                                   "Kraken": "no adapter (dummy.js)"})


def fake_http(replies, calls=None):
    """http_get over a dict of url -> body (bytes or str) or HTTP status."""
    def get(url, path, headers=None, redirects=True):
        if calls is not None:
            calls.append(url)
        reply = replies.get(url, 404)
        if isinstance(reply, int):
            return reply, {}
        path.write_bytes(reply.encode() if isinstance(reply, str) else reply)
        return 200, {}
    return get


class FetchTests(unittest.TestCase):
    def test_page_links_fall_back_to_wayback_and_the_supplement_loads(self):
        live = "https://static.okx.com/cdn/okx/por/chain/okx_por_2023072019.csv.zip"
        gone = "https://static.okx.com/cdn/okx/por/okx_por_20221122.csv.zip"
        body = io.BytesIO()
        with zipfile.ZipFile(body, "w") as archive:
            archive.writestr("x.csv", f"coin,address,amount\nBTC,{A},1\n")
        older = io.BytesIO()
        with zipfile.ZipFile(older, "w") as archive:
            archive.writestr("x.csv", f"coin,address,amount\nBTC,{A},1\nBTC,{B},2\n")
        cdx = "https://web.archive.org/cdx/search/cdx?" + __import__("urllib.parse").parse.urlencode(
            dict(url=gone, fl="timestamp,original", filter="statuscode:200"))
        replies = {"https://www.okx.com/download": f'<a href="{live}">x</a> <a href="{gone}">y</a>',
                   live: body.getvalue(), gone: 404, cdx: f"20230128123213 {gone}\n",
                   f"https://web.archive.org/web/20230128123213id_/{gone}": older.getvalue()}
        registry = source(id="okx-por", entity="OKX", fetch="page_links", parse="por_csv", options=dict(
            pages=["https://www.okx.com/download"], link_pattern=r"static\.okx\.com/cdn/okx/por/(?:chain/)?okx_por_[0-9]+\.csv\.zip",
            date_pattern=r"(20\d{2})(\d{2})(\d{2})"))
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sources, "http_get", fake_http(replies)), \
                mock.patch.object(sources, "log"):
            counts = sources.run_source(registry, Path(tmp))
            rows, manifest = labels.load_supplement(Path(tmp) / "okx-por" / "okx-por_supplement.json")
        self.assertEqual((counts["files"], counts["unique_addresses"]), (2, 2))
        by_address = {address: [row for row in rows if row["address"] == address] for address in (A, B)}
        self.assertEqual(sorted(row["observed_date"] for row in by_address[A]), ["2022-11-22", "2023-07-20"])
        self.assertIn("Listed in 2 of 2 files", by_address[A][0]["historical_note"])
        self.assertTrue(by_address[B][0]["source"].startswith("https://web.archive.org/web/20230128123213id_/"))
        self.assertIn(f"Wayback Machine copy of {gone}, which answered HTTP 404", by_address[B][0]["historical_note"])

    def test_reuse_links_matching_archives_and_downloads_changed_ones(self):
        url = "https://public.bnbstatic.com/static/proof-of-reserve/wallet_address_20230201.zip"
        with tempfile.TemporaryDirectory() as tmp:
            old = Path(tmp) / "old"
            old.mkdir()
            (old / "wallet_address_20230201.zip").write_bytes(b"archived bytes")
            (old / "binance_por_supplement.json").write_text(json.dumps(dict(sources=[dict(
                url=url, sha256=labels.sha256(old / "wallet_address_20230201.zip"), local_path="wallet_address_20230201.zip",
                fetched_at="2026-11-03T00:25:59+00:00")])))
            calls = []
            with mock.patch.object(sources, "http_get", fake_http({url: b"fresh bytes"}, calls)):
                record = sources.Fetcher(Path(tmp) / "new", [old]).archive(url, "wallet_address_20230201.zip")
                self.assertEqual((calls, record["fetched_at"], record["reused_from"].endswith(".zip")),
                                 ([], "2026-11-03T00:25:59+00:00", True))
                (old / "wallet_address_20230201.zip").write_bytes(b"changed")
                record = sources.Fetcher(Path(tmp) / "newer", [old]).archive(url, "wallet_address_20230201.zip")
            self.assertEqual((calls, (Path(tmp) / "newer" / record["local_path"]).read_bytes()), ([url], b"fresh bytes"))

    def test_placeholder_replies_count_as_missing_and_are_fetched_again(self):
        base = json.dumps(dict(data=[dict(currency="btc", address=A)]))
        day = json.dumps(dict(data=[dict(currency="btc", address=A), dict(currency="btc", address=C)]))
        registry = source(id="korbit", entity="Korbit", fetch="list", parse="json_list", options=dict(
            files=[dict(url="https://k/1", observed="2023-11-07"), dict(url="https://k/2", observed="2023-11-08")],
            path="data", address_key="address", chain_key="currency", chain_values=["btc"], require=["data"], list="list",
            placeholder_sha256=[__import__("hashlib").sha256(base.encode()).hexdigest()]))
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sources, "log"), \
                mock.patch.object(sources, "http_get", fake_http({"https://k/1": base, "https://k/2": day})):
            counts = sources.run_source(registry, Path(tmp))
            state = json.loads((Path(tmp) / "korbit" / "fetch_state.json").read_text())
        self.assertEqual((counts["files"], counts["missing"], counts["unique_addresses"], sorted(state)), (1, 1, 2, ["https://k/2"]))

    def test_long_missing_months_are_not_asked_again(self):
        registry = source(id="monthly", fetch="list", parse="json_list", options=dict(
            files=[dict(url="https://m/old", observed="2023-01-01"), dict(url="https://m/new", observed="2026-10-01"),
                   dict(url="https://m/ok", observed="2026-09-01")],
            path="data", address_key="address", chain_key="currency", chain_values=["btc"], list="list"))
        calls = []
        replies = {"https://m/ok": json.dumps(dict(data=[dict(currency="btc", address=A)]))}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sources, "log"), \
                mock.patch.object(sources, "http_get", fake_http(replies, calls)), \
                mock.patch.object(sources, "now", lambda: "2026-11-03T00:00:00+00:00"):
            sources.run_source(registry, Path(tmp))
            calls.clear()
            counts = sources.run_source(registry, Path(tmp))
        self.assertEqual((calls, counts["missing"], counts["unique_addresses"]), (["https://m/new"], 2, 1))

    def test_first_and_last_listing_per_address(self):
        rows = [dict(address=A, entity="X", evidence_type="service_disclosure", observed_date=f"2024-0{n}-01",
                     source=f"https://e/{n}", historical_note="n.") for n in (3, 1, 2)]
        kept = sources.first_and_last(rows, 4)
        self.assertEqual([row["observed_date"] for row in kept], ["2024-01-01", "2024-03-01"])
        self.assertTrue(all(row["historical_note"].endswith("Listed in 3 of 4 files of this source, 2024-01-01 to 2024-03-01.")
                            for row in kept))


class RegistryTests(unittest.TestCase):
    def test_committed_registry_and_its_rules(self):
        registry = sources.load_registry(sources.REGISTRY)
        self.assertTrue({"binance-por", "okx-por", "bitmex-porl", "defillama"} <= {item["id"] for item in registry})
        data = json.loads(sources.REGISTRY.read_text())
        for change, message in ((dict(id="Bad Id"), "source id"), (dict(entity="htx"), "canonical"),
                                (dict(note=f"see {A}"), "addresses"), (dict(parse="nope"), "unknown parse"),
                                (dict(license=""), "license")):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "registry.json"
                path.write_text(json.dumps(dict(data, sources=[{**data["sources"][0], **change}])))
                with self.assertRaisesRegex(ValueError, message):
                    sources.load_registry(path)


class CoverageTests(unittest.TestCase):
    def test_report_per_entity_conflicts_exclusions_and_candidates(self):
        def row(address, entity, kind, date):
            return dict(address=address, entity=entity, source=f"https://{entity.lower()}.example/list", observed_date=date,
                        confidence=sources.CONFIDENCE.get(kind, "publicly_reported"), evidence_type=kind, historical_note="n")
        with tempfile.TemporaryDirectory() as tmp:
            catalog, research = Path(tmp) / "labels", Path(tmp) / "research"
            catalog.mkdir()
            research.mkdir()
            resolved = [row(A, "OKX", "service_disclosure", "2026-01-05"), row(A, "OKX", "third_party_exact_tag", "2021-01-01"),
                        row(C, "Kraken", "third_party_exact_tag", "2020-02-02")]
            conflicts = [row(D, "OKX", "service_disclosure", "2026-03-05"), row(D, "Binance", "service_disclosure", "2026-03-01")]
            labels.write_csv(catalog / "labels_extended.csv", resolved + conflicts)
            labels.write_csv(catalog / "labels_extended_resolved.csv", resolved)
            labels.write_csv(catalog / "labels_extended_conflicts.csv", conflicts)
            labels.write_csv(catalog / "labels_rejected.csv", [], (*labels.FIELDS, "reason", "pack", "tag_index"))
            (catalog / "sources_manifest.json").write_text(json.dumps(dict(counts=dict(evidence_rows=5), supplements=[dict(
                source_id="okx-por", entity="OKX", manifest_path="/x/okx-por_supplement.json",
                sources=[dict(observed="2026-01-05"), dict(observed="2026-03-05")], missing=[dict(url="https://okx.example/x", status=404)],
                excluded=[dict(address=B, custodian="Ceffu", list="hotcold.csv")], dropped_other_networks={"BTC on LIGHTNING": 2},
                counts=dict(rejected_rows=1))])))
            (research / "candidates.json").write_text(json.dumps(dict(candidates=[
                dict(name="OKX", seeds=[dict(seed="defillama")]), dict(name="Upbit", seeds=[dict(seed="coingecko")])])))
            counts = sources.coverage_report(catalog, sources.REGISTRY, research, Path(tmp) / "coverage.json")
            result = json.loads((Path(tmp) / "coverage.json").read_text())
            markdown = (Path(tmp) / "coverage.md").read_text()
        okx = next(item for item in result["entities"] if item["entity"] == "OKX")
        self.assertEqual((okx["addresses"], okx["operator_addresses"], okx["reported_only_addresses"], okx["conflicting_addresses"]),
                         (1, 1, 0, 1))
        self.assertEqual((okx["by_evidence_type"], okx["snapshot_months"], okx["snapshot_gaps"], okx["script_types"]),
                         ({"service_disclosure": 1, "third_party_exact_tag": 1}, ["2026-01", "2026-03"], ["2026-02"], {"P2PKH": 1}))
        kraken = next(item for item in result["entities"] if item["entity"] == "Kraken")
        self.assertEqual((kraken["reported_only_addresses"], kraken["operator_first_observed"]), (1, None))
        self.assertEqual([(item["address"], len(item["evidence"])) for item in result["conflicts"]], [(D, 2)])
        self.assertEqual([item["custodian"] for item in result["custodian_exclusions"]], ["Ceffu"])
        self.assertEqual([item["name"] for item in result["candidates_without_addresses"]], ["Upbit"])
        self.assertEqual(counts, dict(entities=3, conflicts=1, candidates_without_addresses=1))
        self.assertIn("| OKX | 1 | 1 | 0 |", markdown)


if __name__ == "__main__":
    unittest.main()
