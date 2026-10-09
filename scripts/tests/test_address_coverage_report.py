import copy
import csv
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import address_coverage_report as report


class SupplementalReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.summary = dict(start_height=100,end_height=104)
        self.evidence = dict(schema_version=1,sample=dict(start_height=100,end_height=104,blocks=5),
            sources=dict(bip433=dict(url='https://github.com/bitcoin/bips/blob/master/bip-0433.mediawiki'),
                         bitquery_study=dict(url='https://www.bitquery.io/investigations/what-filled-bitcoins-blocks')),
            records=[dict(rank=1,address='synthetic-rune-address',sample_receiving_transactions=10,
                sample_spending_transactions=9,sample_involved_transactions=11,
                supplemental_classification='Published Rune-claim activity report; owner unknown',
                source_refs=['bitquery_study']),
                dict(rank=4,address='bc1pfeessrawgf',sample_receiving_transactions=5,
                sample_spending_transactions=4,sample_involved_transactions=6,
                supplemental_classification='Pay-to-Anchor shared keyless script; not an entity address',
                source_refs=['bip433'])])
        with (self.root/'ranked_reused_addresses.csv').open('w',newline='') as handle:
            writer = csv.DictWriter(handle,fieldnames=['address_rank','address',
                'receiving_transactions','spending_transactions','involved_transactions'])
            writer.writeheader()
            for row in self.evidence['records']:
                writer.writerow(dict(address_rank=row['rank'],address=row['address'],
                    **{name:row['sample_'+name] for name in
                       ('receiving_transactions','spending_transactions','involved_transactions')}))

    def tearDown(self):
        self.temp.cleanup()

    def write(self,evidence):
        (self.root/'top_address_context.json').write_text(json.dumps(evidence))

    def test_optional_and_source_linked_context_leaves_evidence_unchanged(self):
        self.assertEqual(report.top_address_context(self.root,self.summary),[])
        self.write(self.evidence)
        before = (self.root/'top_address_context.json').read_bytes()
        text = '\n'.join(report.top_address_context(self.root,self.summary))
        for expected in ('owner unknown','shared keyless script','[BIP 433](<https://github.com/',
                         '[Bitquery Rune-claim study](<https://www.bitquery.io/',
                         'separate from the frozen label catalog','not entity concentration'):
            self.assertIn(expected,text)
        self.assertEqual(before,(self.root/'top_address_context.json').read_bytes())

    def test_rejects_wrong_range_rank_address_and_counts(self):
        mutations = [lambda e:e['sample'].update(end_height=105),
            lambda e:e['records'][0].update(rank=2),
            lambda e:e['records'][0].update(address='different-address'),
            lambda e:e['records'][0].update(sample_receiving_transactions=12),
            lambda e:e['records'].append(copy.deepcopy(e['records'][0]))]
        for mutate in mutations:
            evidence = copy.deepcopy(self.evidence)
            mutate(evidence); self.write(evidence)
            with self.assertRaises(ValueError):
                report.top_address_context(self.root,self.summary)

    def test_rejects_missing_or_nonweb_sources(self):
        for value in ('javascript:alert(1)','https://user:password@example.com/evidence',''):
            evidence = copy.deepcopy(self.evidence)
            evidence['sources']['bip433']['url'] = value
            self.write(evidence)
            with self.assertRaisesRegex(ValueError,'source URL'):
                report.top_address_context(self.root,self.summary)

    def test_btc_format_preserves_large_integer_satoshi_precision(self):
        self.assertEqual(report.btc(0),'0.00000000')
        self.assertEqual(report.btc(100000008),'1.00000008')
        self.assertEqual(report.btc(1234567890123456789),'12,345,678,901.23456789')

    def test_temporal_table_requires_all_categories_and_reconciled_counts(self):
        path = self.root/'transaction_coverage.csv'
        rows = [dict(threshold=2,period=0,category=key,transactions=2 if key=='uncovered' else 0,
            transaction_pct=100 if key=='uncovered' else 0) for key,_,_ in report.CATEGORIES]
        summary = dict(denominators=[dict(period=0,coinbase=False,start_height=100,
                                          end_height=104,transactions=2)])
        def write_rows(values):
            with path.open('w',newline='') as handle:
                writer=csv.DictWriter(handle,fieldnames=list(rows[0]))
                writer.writeheader();writer.writerows(values)
        write_rows(rows)
        self.assertEqual(report.temporal_rows(self.root,summary)[0][-1],'100.00%')
        write_rows(rows[:-1])
        with self.assertRaisesRegex(ValueError,'denominators'):
            report.temporal_rows(self.root,summary)
        rows[-1]['transactions']=1
        write_rows(rows)
        with self.assertRaisesRegex(ValueError,'denominators'):
            report.temporal_rows(self.root,summary)

    def test_top_entities_are_ranked_and_shared_transactions_are_not_added(self):
        rows=[dict(entity=f'Entity {rank}',entity_rank=rank,involved_transactions=91-rank,
                   input_satoshi=5*rank,output_satoshi=5*rank) for rank in range(6,0,-1)]
        path=self.root/'ranked_entities.csv'
        def write_rows():
            with path.open('w',newline='') as handle:
                writer=csv.DictWriter(handle,fieldnames=list(rows[0]))
                writer.writeheader();writer.writerows(rows)
        write_rows()
        denominator=dict(transactions=100,gross_satoshi=1000)
        result=report.top_entity_rows(self.root,denominator)
        self.assertEqual(len(result),5)
        self.assertEqual(result[0],['Entity 1','90','90.0000%','1.0000%'])
        self.assertEqual(result[-1][0],'Entity 5')
        # Per-entity transaction counts may sum beyond the universe due to overlap.
        self.assertGreater(sum(int(row[1]) for row in result),denominator['transactions'])
        for key,value in (('involved_transactions',101),('involved_transactions',-1),
                          ('input_satoshi',-1),('input_satoshi',1001)):
            previous=rows[0][key];rows[0][key]=value;write_rows()
            with self.assertRaisesRegex(ValueError,'denominators'):
                report.top_entity_rows(self.root,denominator)
            rows[0][key]=previous


class TopTenFlashReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.denominator = dict(transactions=1000,events=10000,gross_satoshi=10**16)
        self.summary = dict(start_height=100,end_height=104,source_fingerprint='fixture-source',
            expected_blocks_sha256='fixture-blocks',concentration_checkpoints=[dict(
                kind='reused_address',top_n=10,selected_count=10,transactions=123,
                denominator_transactions=1000)])
        records=[]
        metrics=('input_events','output_events','input_satoshi','output_satoshi')
        for rank in range(1,11):
            row=dict(address_rank=rank,address=f'synthetic-{rank}',coinbase_role_transactions=0)
            for metric,value in zip(metrics,(3*rank,2*rank,1000*rank,990*rank)):
                row['coinbase_'+metric]=0
                row['noncoinbase_'+metric]=value
            row['noncoinbase_matched_events']=5*rank
            row['noncoinbase_gross_satoshi']=1990*rank
            records.append(row)
        totals={key:sum(row[key] for row in records) for key in records[0]
                if key not in ('address','address_rank')}
        totals['noncoinbase_transaction_union']=123
        self.evidence=dict(schema_version=1,status='verified',start=100,end=104,
            denominators={'noncoinbase_'+key:value for key,value in self.denominator.items()},
            coinbase_verification=dict(manifest=dict(binding=dict(start=100,end=104,
                source_fingerprint='fixture-source',expected_blocks_sha256='fixture-blocks')),
                coinbase_roles=[],address_partitions=[dict(address=row['address'],partition=0) for row in records]),
            totals=totals,addresses=records)
        with (self.root/'ranked_reused_addresses.csv').open('w',newline='') as handle:
            writer=csv.DictWriter(handle,fieldnames=['address_rank','address',*metrics]);writer.writeheader()
            for row in records:
                writer.writerow(dict(address_rank=row['address_rank'],address=row['address'],
                    **{key:row['noncoinbase_'+key] for key in metrics}))

    def tearDown(self):
        self.temp.cleanup()

    def write(self,evidence):
        (self.root/'top10_flash_relevance.json').write_text(json.dumps(evidence))

    def test_optional_exact_amounts_and_transaction_union(self):
        self.assertEqual(report.top10_flash_relevance(self.root,self.summary,self.denominator),[])
        self.write(self.evidence)
        text='\n'.join(report.top10_flash_relevance(self.root,self.summary,self.denominator))
        self.assertIn('**12.30%**',text)
        self.assertIn('| Distinct transaction union | 123 | 1,000 | 12.30000000% |',text)
        self.assertIn('0.00109450',text)
        self.assertIn('exact noncoinbase basis',text)
        self.assertIn('nor rendered flash brightness',text)

    def test_rejects_stale_source_denominator_rank_union_and_coinbase_basis(self):
        mutations=[lambda e:e.update(end=105),
            lambda e:e['coinbase_verification']['manifest']['binding'].update(source_fingerprint='other'),
            lambda e:e['denominators'].update(noncoinbase_gross_satoshi=1),
            lambda e:e['addresses'][0].update(address='different-address'),
            lambda e:e['addresses'][0].update(noncoinbase_input_satoshi=1),
            lambda e:e['totals'].update(noncoinbase_transaction_union=124),
            lambda e:e['totals'].update(noncoinbase_gross_satoshi=1),
            lambda e:e['addresses'][0].update(coinbase_output_events=1),
            lambda e:e['coinbase_verification'].update(address_partitions=[])]
        for mutate in mutations:
            evidence=copy.deepcopy(self.evidence);mutate(evidence);self.write(evidence)
            with self.assertRaises(ValueError):
                report.top10_flash_relevance(self.root,self.summary,self.denominator)


if __name__=='__main__':
    unittest.main()
