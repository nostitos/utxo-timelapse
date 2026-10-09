import contextlib
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_address_coverage_extract import FakeRpc, block
import address_coverage_extract as extractor
import address_coverage_analyze as analyzer
import address_coverage_verify as verifier
import address_coverage_report as reporter


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.data = cls.root/'data'
        cls.expected = cls.root/'expected.json'
        cls.expected.write_text(json.dumps({'schema_version':1,'start':100,'end':101,
            'blocks':[{'height':h,'hash':block(h)['hash']} for h in [100,101]]}))
        rpc = FakeRpc({h:block(h) for h in [100,101]})
        with patch.object(extractor,'Rpc',return_value=rpc), contextlib.redirect_stdout(io.StringIO()):
            code = extractor.main(['--rpc-url','http://127.0.0.1:8332','--cookie-file',str(cls.root/'cookie'),
                '--expected-blocks',str(cls.expected),'--output',str(cls.data),'--start','100','--end','101'])
        if code:raise AssertionError('fixture extraction failed')
        cls.verification = verifier.verify(cls.data,cls.expected,100,101)
        cls.labels = cls.root/'labels.csv'
        with cls.labels.open('w',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=analyzer.LABEL_COLUMNS);writer.writeheader()
            writer.writerow(dict(address='address-A',entity='Fixture exchange',source='https://example.test/disclosure',
                observed_date='2026-09-17',confidence='publicly_reported',evidence_type='service_disclosure',historical_note='Fixture'))
        cls.analysis=cls.root/'analysis'
        with contextlib.redirect_stdout(io.StringIO()):
            cls.summary=analyzer.analyze(cls.data,cls.labels,cls.analysis,start=100,end=101,
                window_blocks=1,memory_limit='512MB',threads=1,expected_blocks=cls.expected)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_complete_extraction_analysis_report(self):
        report=reporter.report(self.analysis,self.data/'verification.json')
        text=report.read_text()
        self.assertIn('4 noncoinbase transactions',text)
        self.assertIn('12 creation/spend events',text)
        self.assertIn('Connected coverage is not identified ownership',text)
        self.assertIn('**10 creation/spend events**',text)
        self.assertIn('**1.00000008 BTC**',text)
        self.assertIn('0.80000008',text)
        self.assertIn('Direction of connection (reuse threshold 2)',text)
        self.assertIn('Change across the sample (reuse threshold 2)',text)
        self.assertIn('Address/script reuse concentration is not entity concentration',text)
        self.assertIn('already directly connected',text)
        self.assertIn('Largest labelled organisations by transaction involvement',text)
        self.assertIn('| Fixture exchange | 4 | 100.0000% | 80.0000% |',text)
        self.assertIn('transaction counts are not additive',text)
        for name in ['coverage.png','coverage.svg','concentration.png','concentration.svg']:
            self.assertGreater((self.analysis/name).stat().st_size,1000)

    def test_report_rejects_different_source(self):
        changed=dict(self.verification,source_fingerprint='other-source')
        path=self.root/'different.json';path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError,'source binding'):
            reporter.report(self.analysis,path)

    def test_report_rejects_incomplete_range(self):
        path=self.root/'incomplete.json';path.write_text(json.dumps(dict(self.verification,complete=False)))
        with self.assertRaisesRegex(ValueError,'verified complete'):
            reporter.report(self.analysis,path)


if __name__=='__main__':unittest.main()
