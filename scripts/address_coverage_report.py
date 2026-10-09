#!/usr/bin/env python3
"""Render a verified coverage summary into Markdown and standalone chart files."""
import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
from urllib.parse import urlparse


CATEGORIES = [('known_only','Known only','#2271B2'),('reused_only','Reused only','#3DB7A5'),
              ('both','Known and reused','#124F5C'),('counterparty_only','Additional counterparties','#E69F00'),
              ('uncovered','Uncovered','#D2D6D9')]
SCOPE_NAMES = {'known':'Known addresses', 'reused':'Reused addresses',
               'known_or_reused':'Known or reused', 'counterparty':'Counterparty addresses',
               'known_or_reused_or_counterparty':'Known, reused or counterparty'}


def number(value):
    return f'{int(value):,}'


def percentage(value):
    return '<0.01%' if 0 < float(value) < .005 else f'{float(value):.2f}%'


def btc(satoshi):
    """Format integer satoshis without rounding through binary floats."""
    whole, fraction = divmod(int(satoshi), 100_000_000)
    return f'{whole:,}.{fraction:08d}'


def markdown_table(headers, rows):
    safe = lambda value: str(value).replace('|', '\\|').replace('\n', ' ')
    return '\n'.join(['| '+' | '.join(map(safe,headers))+' |',
                       '| '+' | '.join('---' for _ in headers)+' |'] +
                      ['| '+' | '.join(map(safe,row))+' |' for row in rows])


def top_address_context(root, summary):
    """Accept supplemental interpretation only for the exact ranked sample."""
    path = root/'top_address_context.json'
    if not path.exists():
        return []
    evidence = json.loads(path.read_text())
    sample = evidence.get('sample', {})
    if evidence.get('schema_version') != 1 or (
            sample.get('start_height'), sample.get('end_height'), sample.get('blocks')) != (
            summary['start_height'], summary['end_height'],
            summary['end_height']-summary['start_height']+1):
        raise ValueError('supplemental top-address evidence has a different sample range')
    records = evidence.get('records')
    sources = evidence.get('sources')
    if not isinstance(records, list) or not records or not isinstance(sources, dict):
        raise ValueError('supplemental top-address evidence requires records and sources')
    with (root/'ranked_reused_addresses.csv').open(newline='') as handle:
        ranking = {int(row['address_rank']): row for row in csv.DictReader(handle)}
    seen_ranks, seen_addresses = set(), set()
    rows = []
    source_names = {'bip433':'BIP 433', 'bitquery_study':'Bitquery Rune-claim study',
                    'walletexplorer_api':'WalletExplorer lookup',
                    'walletexplorer_method':'WalletExplorer method'}
    if any(not isinstance(row,dict) or type(row.get('rank')) is not int for row in records):
        raise ValueError('supplemental top-address evidence requires integer ranks')
    for record in sorted(records, key=lambda row: row['rank']):
        rank, address = record.get('rank'), record.get('address')
        if (type(rank) is not int or rank < 1 or rank in seen_ranks
                or not isinstance(address, str) or address in seen_addresses
                or rank not in ranking or ranking[rank]['address'] != address):
            raise ValueError('supplemental top-address evidence does not match ranked addresses')
        for metric in ('receiving_transactions','spending_transactions','involved_transactions'):
            if record.get('sample_'+metric) != int(ranking[rank][metric]):
                raise ValueError(f'supplemental top-address evidence has stale {metric} at rank {rank}')
        seen_ranks.add(rank); seen_addresses.add(address)
        refs = record.get('source_refs')
        if not isinstance(refs, list) or not refs:
            raise ValueError('supplemental top-address record requires source references')
        for ref in refs:
            source = sources.get(ref, {}) if isinstance(ref,str) else {}
            url = source.get('url', '')
            if not isinstance(url,str):
                raise ValueError('supplemental top-address evidence has an invalid source URL')
            parsed = urlparse(url)
            if (parsed.scheme not in ('https','http') or not parsed.hostname
                    or parsed.username or parsed.password or any(c in url for c in '<>\r\n')):
                raise ValueError('supplemental top-address evidence has an invalid source URL')
        selected = [ref for ref in refs if ref in ('bip433','bitquery_study')]
        if not selected:
            selected = ['walletexplorer_api'] if 'walletexplorer_api' in refs else refs
        links = ', '.join(f'[{source_names.get(ref,ref)}](<{sources[ref]["url"]}>)' for ref in selected)
        context = record.get('supplemental_classification') or record.get('identity_search_result')
        if not isinstance(context, str) or not context.strip():
            raise ValueError('supplemental top-address record requires an interpretation')
        rows.append([rank,f'`{address}`',context,links])
    return ['### Supplemental context for the ranked addresses','',
        'Address/script reuse concentration is not entity concentration. A shared keyless '
        'protocol script can have many unrelated users, and a published activity pattern '
        'does not identify its owners.','',
        markdown_table(['Reuse rank','Address/script','Published context','Source'],rows),'',
        'Rune-claim descriptions are the cited publisher\'s behavioral interpretation; they '
        'do not establish common control or classify every transaction in this sample. '
        'Provider cluster labels also do not establish ownership. An unsuccessful bounded '
        'identity search is not proof that no attribution exists.','',
        'This supplemental context is separate from the frozen label catalog and changes '
        'no coverage set, ranking or metric. '
        '[Retained supplemental evidence](top_address_context.json).','']


def temporal_rows(root, summary):
    with (root/'transaction_coverage.csv').open(newline='') as handle:
        rows = [row for row in csv.DictReader(handle)
                if int(row['threshold'])==2 and int(row['period'])>=0]
    by_period = {}
    for row in rows:
        period = int(row['period'])
        categories = by_period.setdefault(period,{})
        if row['category'] in categories:
            raise ValueError('duplicate category in temporal coverage CSV')
        categories[row['category']] = row
    result = []
    for denominator in summary['denominators']:
        period = denominator['period']
        if period<0 or denominator['coinbase']:
            continue
        selected = by_period.pop(period,{})
        if set(selected) != {key for key,_,_ in CATEGORIES} or sum(
                int(row['transactions']) for row in selected.values()) != denominator['transactions']:
            raise ValueError('temporal coverage CSV does not match report denominators')
        result.append([f"{number(denominator['start_height'])}–{number(denominator['end_height'])}",
            number(denominator['transactions'])]+[
                percentage(selected[key]['transaction_pct']) for key,_,_ in CATEGORIES])
    if by_period:
        raise ValueError('temporal coverage CSV contains unexpected periods')
    return result


def top_entity_rows(root, denominator):
    with (root/'ranked_entities.csv').open(newline='') as handle:
        entities = list(csv.DictReader(handle))
    seen_ranks, seen_entities = set(), set()
    for entity in entities:
        rank = int(entity['entity_rank'])
        transactions = int(entity['involved_transactions'])
        inputs, outputs = int(entity['input_satoshi']),int(entity['output_satoshi'])
        if (rank<1 or rank in seen_ranks or not entity['entity'].strip()
                or entity['entity'] in seen_entities
                or not 0<=transactions<=denominator['transactions']
                or inputs<0 or outputs<0 or inputs+outputs>denominator['gross_satoshi']):
            raise ValueError('ranked entity counts or values exceed report denominators')
        seen_ranks.add(rank); seen_entities.add(entity['entity'])
    result = []
    for entity in sorted(entities,key=lambda row:int(row['entity_rank']))[:5]:
        transactions = int(entity['involved_transactions'])
        gross = int(entity['input_satoshi'])+int(entity['output_satoshi'])
        share = lambda value,key: Decimal(value)*100/Decimal(denominator[key]) if denominator[key] else Decimal(0)
        result.append([entity['entity'],number(transactions),
                       f"{share(transactions,'transactions'):.4f}%",
                       f"{share(gross,'gross_satoshi'):.4f}%"])
    return result


def top10_flash_relevance(root, summary, denominator):
    """Bind optional own-address activity totals to the verified top-ten union."""
    path = root/'top10_flash_relevance.json'
    if not path.exists():
        return []
    evidence = json.loads(path.read_text())
    if (evidence.get('schema_version') != 1 or evidence.get('status') != 'verified'
            or (evidence.get('start'),evidence.get('end')) != (
                summary['start_height'],summary['end_height'])):
        raise ValueError('top-ten flash evidence has an unverified or different sample')
    verification = evidence.get('coinbase_verification',{})
    binding = verification.get('manifest',{}).get('binding',{})
    if (binding.get('start'),binding.get('end')) != (summary['start_height'],summary['end_height']):
        raise ValueError('top-ten flash evidence has a different role-verification sample')
    for key in ('source_fingerprint','expected_blocks_sha256'):
        if not summary.get(key) or binding.get(key) != summary[key]:
            raise ValueError(f'top-ten flash evidence source binding differs: {key}')
    for key in ('events','gross_satoshi','transactions'):
        if evidence.get('denominators',{}).get('noncoinbase_'+key) != denominator[key]:
            raise ValueError(f'top-ten flash evidence denominator differs: {key}')
    with (root/'ranked_reused_addresses.csv').open(newline='') as handle:
        ranking = {int(row['address_rank']):row for row in csv.DictReader(handle)
                   if int(row['address_rank'])<=10}
    records = evidence.get('addresses',[])
    if (len(ranking)!=10 or len(records)!=10 or any(not isinstance(row,dict)
            or type(row.get('address_rank')) is not int for row in records)
            or {row['address_rank'] for row in records} != set(range(1,11))):
        raise ValueError('top-ten flash evidence requires exactly ranks 1 through 10')
    metrics = ('input_events','output_events','input_satoshi','output_satoshi')
    sums = dict.fromkeys(metrics,0)
    coinbase_metrics = ('role_transactions',*metrics)
    for row in records:
        ranked = ranking[row['address_rank']]
        if row.get('address') != ranked['address']:
            raise ValueError('top-ten flash evidence does not match ranked addresses')
        # This supplemental format certifies zero coinbase roles for these ten,
        # allowing their exact ranked event/value totals to be compared directly.
        if any(row.get('coinbase_'+key) != 0 for key in coinbase_metrics):
            raise ValueError('top-ten flash evidence requires verified zero coinbase roles')
        for metric in metrics:
            value = row.get('noncoinbase_'+metric)
            if type(value) is not int or value<0 or value != int(ranked[metric]):
                raise ValueError(f'top-ten flash evidence differs from ranked {metric}')
            sums[metric] += value
        for combined,components in (('matched_events',('input_events','output_events')),
                                     ('gross_satoshi',('input_satoshi','output_satoshi'))):
            if row.get('noncoinbase_'+combined) != sum(row['noncoinbase_'+key] for key in components):
                raise ValueError('top-ten flash evidence has inconsistent address totals')
    addresses = {row['address'] for row in records}
    if (verification.get('coinbase_roles') != [] or
            {row.get('address') for row in verification.get('address_partitions',[])} != addresses):
        raise ValueError('top-ten flash evidence coinbase check covers different addresses')
    totals = evidence.get('totals',{})
    if any(totals.get('coinbase_'+key) != 0 for key in coinbase_metrics):
        raise ValueError('top-ten flash evidence requires verified zero coinbase totals')
    sums['matched_events'] = sums['input_events']+sums['output_events']
    sums['gross_satoshi'] = sums['input_satoshi']+sums['output_satoshi']
    if any(totals.get('noncoinbase_'+key) != value for key,value in sums.items()):
        raise ValueError('top-ten flash evidence does not reconcile to address totals')
    checkpoints = [row for row in summary['concentration_checkpoints']
                   if row['kind']=='reused_address' and row['top_n']==10]
    if (len(checkpoints)!=1 or checkpoints[0]['selected_count']!=10
            or checkpoints[0]['denominator_transactions']!=denominator['transactions']
            or totals.get('noncoinbase_transaction_union') != checkpoints[0]['transactions']):
        raise ValueError('top-ten flash evidence differs from the transaction-union checkpoint')
    union = checkpoints[0]['transactions']
    share = lambda numerator,key: Decimal(numerator)*100/Decimal(denominator[key]) if denominator[key] else Decimal(0)
    return ['### Top-ten reuse and relevance to flashes','',
        f"The ten most reused addresses/scripts touch **{share(union,'transactions'):.2f}%** "
        f"of noncoinbase transactions, while their own creation/spend amounts account for "
        f"**{share(sums['gross_satoshi'],'gross_satoshi'):.5f}%** of gross BTC activity.",'',
        markdown_table(['Measure','Top ten','All noncoinbase activity','Share'],[
            ['Distinct transaction union',number(union),number(denominator['transactions']),
             f"{share(union,'transactions'):.8f}%"],
            ['Own creation/spend events',number(sums['matched_events']),number(denominator['events']),
             f"{share(sums['matched_events'],'events'):.8f}%"],
            ['Own gross BTC activity',btc(sums['gross_satoshi']),btc(denominator['gross_satoshi']),
             f"{share(sums['gross_satoshi'],'gross_satoshi'):.8f}%"]]),'',
        'The event and amount comparison uses an exact noncoinbase basis: a separate check '
        'found zero coinbase roles for these ten addresses/scripts. Transaction coverage is '
        'a union, not a sum of address transaction counts. Events and amounts include only '
        'the addresses\' own outputs and spends, not every event in connected transactions. '
        'Gross BTC counts creation and spending separately; it measures neither economic '
        'transfer volume nor rendered flash brightness. '
        '[Retained flash-relevance evidence](top10_flash_relevance.json).','']


def report(output_dir, verification_file):
    root = Path(output_dir)
    summary = json.loads((root/'summary.json').read_text())
    verification = json.loads(Path(verification_file).read_text())
    if not verification.get('complete') or (verification['start'],verification['end']) != (summary['start_height'],summary['end_height']):
        raise ValueError('report requires verified complete extraction for this window')
    for key in ('source_fingerprint','expected_blocks_sha256'):
        if not summary.get(key) or summary[key] != verification.get(key):
            raise ValueError(f'analysis/verification source binding differs: {key}')
    denominator = next(r for r in summary['denominators'] if r['period']==-1 and not r['coinbase'])
    if denominator['transactions'] != verification['noncoinbase_transaction_count']:
        raise ValueError('analysis/extraction transaction counts differ')
    all_events = sum(r['events'] for r in summary['denominators'] if r['period']==-1)
    if all_events != verification['event_count']:
        raise ValueError('analysis/extraction event counts differ')
    context_lines = top_address_context(root,summary)
    flash_lines = top10_flash_relevance(root,summary,denominator)
    temporal = temporal_rows(root,summary)
    entities = top_entity_rows(root,denominator)
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,
                         'axes.spines.right':False,'figure.dpi':160,'svg.fonttype':'none'})
    fig, ax = plt.subplots(figsize=(10,4.4),layout='constrained')
    thresholds = summary['thresholds']
    left = [0.0]*len(thresholds)
    for key,label,color in CATEGORIES:
        vals=[next(r['transaction_pct'] for r in t['coverage'] if r['category']==key) for t in thresholds]
        ax.barh(range(len(thresholds)),vals,left=left,color=color,label=label,height=.62)
        left=[a+b for a,b in zip(left,vals)]
    ax.set(yticks=range(len(thresholds)),yticklabels=[f"{t['threshold']}+ receipts" for t in thresholds],
           xlim=(0,100),xlabel='Share of all noncoinbase transactions (%)',
           title='Direct address connections and one counterparty expansion')
    ax.invert_yaxis(); ax.legend(loc='upper center',bbox_to_anchor=(.5,-.18),ncol=3,frameon=False)
    fig.savefig(root/'coverage.png');fig.savefig(root/'coverage.svg');plt.close(fig)
    with (root/'concentration_curves.csv').open(newline='') as f: curves=list(csv.DictReader(f))
    fig,axes=plt.subplots(1,2,figsize=(10,4.6),layout='constrained')
    fig.supxlabel('Different vertical scales; both use all noncoinbase transactions.\n'
                  'Address/script reuse concentration is not entity concentration.',fontsize=10)
    for ax,kind,title,color in zip(axes,['reused_address','known_entity'],
            ['Most reused addresses/scripts','Publicly labelled entities'],['#3DB7A5','#2271B2']):
        rows=[r for r in curves if r['kind']==kind and int(r['top_n'])<=int(r['selected_count'])]
        ax.plot([int(r['top_n']) for r in rows],[float(r['transaction_pct']) for r in rows],
                color=color,lw=2,marker='o' if len(rows)==1 else None)
        ax.set(title=title,xlabel='Top N (ranked over the full sample)',ylabel='Distinct transaction coverage (%)',ylim=(0,100))
        if rows:
            last = rows[-1]
            if kind=='known_entity':
                ax.set_ylim(0,max(.1,min(100,float(last['transaction_pct'])*1.2)))
                ax.set_xticks(sorted({n for n in (1,5,10,20,int(last['top_n'])) if n<=int(last['top_n'])}))
            ax.annotate(f"{float(last['transaction_pct']):.4f}%",
                        (int(last['top_n']),float(last['transaction_pct'])),
                        xytext=(-4,8),textcoords='offset points',ha='right',fontsize=9)
        if kind=='reused_address':ax.set_xscale('log')
        if len(rows)==1:
            ax.set_xlim(.8,1.2)
            ax.set_xticks([1],labels=['1'])
            ax.minorticks_off()
        if not rows:ax.text(.5,.5,'No observed labelled activity' if kind=='known_entity' else 'No reused addresses',
                            ha='center',va='center',transform=ax.transAxes)
        ax.grid(axis='y',alpha=.2)
    fig.savefig(root/'concentration.png');fig.savefig(root/'concentration.svg');plt.close(fig)
    baseline=next(t for t in thresholds if t['threshold']==2)
    directions = {(row['scope'],row['direction']):row for row in baseline['directions']}
    cov={r['category']:r for r in baseline['coverage']}
    known=cov['known_only']['transaction_pct']+cov['both']['transaction_pct']
    direct=100-cov['uncovered']['transaction_pct']-cov['counterparty_only']['transaction_pct']
    expanded=100-cov['uncovered']['transaction_pct']
    dates=[datetime.fromtimestamp(verification[k],timezone.utc).date().isoformat()
           for k in ['earliest_block_time','latest_block_time']]
    periods=sum(r['period']>=0 and not r['coinbase'] for r in summary['denominators'])
    lines=['# Known-address and reused-address coverage','',
        f"Blocks **{number(summary['start_height'])}–{number(summary['end_height'])}**, {dates[0]} to {dates[1]} (block timestamps, UTC). "
        f"Complete extraction: **{number(denominator['transactions'])} noncoinbase transactions**, "
        f"{number(verification['block_count'])} coinbase transactions and {number(verification['event_count'])} creation/spend events, including coinbase outputs.",'',
        f"At the two-receipt reuse threshold, publicly labelled addresses touch **{known:.2f}%** of transactions. "
        f"Known or reused addresses directly touch **{direct:.2f}%**. Including counterparties' other transactions raises connected coverage to **{expanded:.2f}%**.",'',
        '**Connected coverage is not identified ownership.** Counterparties may include customer addresses, change, batching and collaborative transactions. "Known" means a sourced published label; historical control throughout this window is not established.','',
        '## Transaction coverage','',
        markdown_table(['Receiving transactions required for reuse','Known only','Reused only','Both','Additional counterparties','Uncovered'],
         [[t['threshold']]+[percentage(next(r['transaction_pct'] for r in t['coverage'] if r['category']==key)) for key,_,_ in CATEGORIES] for t in thresholds]),'',
        'Every row partitions the same noncoinbase transaction universe; percentages total 100% before rounding.','',
        '![Coverage by reuse threshold](coverage.png)','',
        '### Direction of connection (reuse threshold 2)','',
        markdown_table(['Address set','Spending from only','Sending to only','Both directions'],
         [[name]+[f"{directions[(scope,direction)]['transaction_pct']:.2f}%" for direction in
            ('spending_from_only','sending_to_only','both_directions')]
          for scope,name in SCOPE_NAMES.items()]),'',
        f"Every percentage uses all {number(denominator['transactions'])} noncoinbase transactions. "
        'The three directions within a row are disjoint; address sets in different rows overlap.','',
        '### Change across the sample (reuse threshold 2)','',
        markdown_table(['Blocks','Noncoinbase transactions']+[label for _,label,_ in CATEGORIES],temporal),'',
        'Each row uses that period\'s noncoinbase transactions as its denominator. '
        'Known, reused and counterparty address sets are fixed using the complete sample.','',
        '## Address reuse','',
        markdown_table(['Distinct receiving transactions','Addresses meeting threshold','Share of receiving addresses'],
         [[t['threshold'],number(t['address_counts']['reused']),
           f"{100*t['address_counts']['reused']/summary['observed_receiving_addresses']:.2f}%" if summary['observed_receiving_addresses'] else '0.00%'] for t in thresholds]),'',
        f"Denominator: {number(summary['observed_receiving_addresses'])} addresses receiving at least once in this window, including coinbase receipts. Receiving addresses are distinguished from addresses appearing only as spent prevouts.",'',
        '## Output activity actually matching addresses','',
        'These figures count only events whose own address matches the set. They do not assign every output of a connected transaction to an exchange. Values sum input prevouts and created outputs: gross UTXO activity, not economic transfer volume or visible brightness.','',
        f"Noncoinbase activity denominators: **{number(denominator['events'])} creation/spend events** "
        f"({number(denominator['input_events'])} spends + {number(denominator['output_events'])} creations), "
        f"and **{btc(denominator['gross_satoshi'])} BTC** of gross activity "
        f"({btc(denominator['input_satoshi'])} BTC spent + {btc(denominator['output_satoshi'])} BTC created). "
        'Nonaddress scripts remain in these totals.','',
        markdown_table(['Set (reuse threshold 2)','Creation/spend events','Event share','Gross BTC activity','Gross BTC activity share'],
         [[SCOPE_NAMES[r['scope']],number(r['events']),f"{r['events_pct']:.2f}%",btc(r['gross_satoshi']),f"{r['gross_satoshi_pct']:.2f}%"] for r in baseline['matched_activity']]),'',
        '**Counterparty addresses** here includes their own events even in transactions '
        'already directly connected to a known or reused address. The direction table follows '
        'the same address-set definition. Only the transaction category **Additional counterparties** '
        '(`counterparty_only`) counts transactions added beyond direct coverage.','',
        '## Concentration','',
        '![Address/script reuse and labelled-entity concentration are separate measures](concentration.png)','',
        '**Address/script reuse concentration is not entity concentration.** The left curve '
        'ranks exact addresses/scripts by receiving transactions; the right curve uses the '
        'frozen published entity labels. Both show unions of noncoinbase transactions.','',
        markdown_table(['Set','Top N requested','Available selected','Distinct transactions','Coverage'],
         [[r['kind'],r['top_n'],r['selected_count'],number(r['transactions']),f"{r['transaction_pct']:.4f}%"] for r in summary['concentration_checkpoints']]),'',
        *flash_lines,
        *context_lines,
        '## Evidence and interpretation','',
        '### Largest labelled organisations by transaction involvement','',
        markdown_table(['Published entity label','Distinct noncoinbase transactions',
                        'Share of all noncoinbase transactions','Own gross BTC share'],entities)
            if entities else 'No labelled organisations had observed noncoinbase activity.','',
        'These are the top five available published entity labels. Transaction shares use '
        'all noncoinbase transactions; gross BTC shares use the full noncoinbase gross '
        'amount denominator above and only the entity-labelled addresses\' own events. '
        '**Entities can share transactions, so their transaction counts are not additive.** '
        'Label dates, sources and historical-control caveats remain in the '
        '[ranked entity evidence](ranked_entities.csv).','',
        markdown_table(['Label evidence tier','Catalog addresses','Observed addresses','Transaction coverage','Matched event share','Gross BTC activity share'],
         [[r['tier'],number(r['label_addresses']),number(r['observed_addresses']),f"{r['transactions_pct']:.2f}%",f"{r['events_pct']:.2f}%",f"{r['gross_satoshi_pct']:.2f}%"] for r in summary['known_evidence_tiers']]),'',
        f"The catalog contains {number(summary['labels']['resolved'])} unambiguous labelled addresses; {number(summary['labels']['conflicting'])} conflicting addresses are excluded from the known set. Only labels matching observed addresses affect coverage.",'',
        '- Published reserve lists cover selected wallets, with uneven provider and date coverage. Missing labels do not mean activity is unrelated to exchanges.',
        '- Third-party labels retain their evidence tier and may originate from provider inference. This analysis performs no ownership clustering.',
        f"- Reuse is defined retrospectively across this entire sample, including coinbase receipts. The {periods} comparisons of up to {number(summary['window_blocks'])} blocks use those fixed sets; they are not an online detection backtest.",
        '- Each address is counted once per receiving transaction. Receiving once and later spending is not reuse. Multiple outputs to one address in the same transaction do not establish reuse.',
        '- Counterparties are only opposite-side nonseed addresses. Their other transactions add one expansion; no recursive expansion is performed.',
        '- Input prevouts created before the sample are resolved. Addresses used only before this window may have their lifetime reuse understated.',
        '- Coinbase is excluded from transaction and activity percentage denominators and listed separately. Nonaddress scripts remain in applicable event/value denominators.','',
        '- Ranked-address CSV receipt counts and raw output-event/value columns include coinbase '
        'receipts. Their `involved_transactions` column counts noncoinbase transactions; do not '
        'divide raw ranking values by the coverage denominators without first excluding coinbase.','',
        '## Data files','',
        f'- [Transaction coverage, including {periods} time windows](transaction_coverage.csv)',
        '- [Spending-from / sending-to direction breakdowns](transaction_directions.csv)',
        '- [Matched event and value coverage](matched_activity.csv)',
        '- [Ranked reused addresses](ranked_reused_addresses.csv)',
        '- [Ranked known addresses](ranked_known_addresses.csv)',
        '- [Ranked labelled entities](ranked_entities.csv)',
        '- [Ranked counterparties](ranked_counterparty_addresses.csv)',
        '- [Concentration curves](concentration_curves.csv)',
        '- [Label evidence](label_evidence.csv)',
        '- [Exact denominators](denominators.csv)',
        '- [Machine-readable summary](summary.json)','']
    tiers=root/'known_evidence_tiers.csv'
    if tiers.exists():lines += ['- [Known-address coverage by evidence tier](known_evidence_tiers.csv)','']
    (root/'report.md').write_text('\n'.join(lines))
    return root/'report.md'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True,type=Path)
    parser.add_argument('--verification-file',required=True,type=Path)
    args=parser.parse_args()
    print(report(args.output_dir,args.verification_file))


if __name__=='__main__':
    main()
