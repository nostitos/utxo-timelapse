#!/usr/bin/env node
// Prints the settings reference tables of docs/landscape.md from the settings schema:
// one table per group with range, default, the looks and quality tiers that change each
// setting, and its notes (WebGPU, personal preference, rebuild cost, when it has an effect).
//
//   node landscape/tools/settings-reference.mjs > /tmp/settings-reference.md
import { SCHEMA, GROUPS, LOOKS, QUALITY_ORDER, LOOK_PRESETS, QUALITY_PRESETS } from '../web/settings.schema.js';

const SCHEMA_BY_ID = new Map(SCHEMA.map((e) => [e.id, e]));

function num(v) {
  if (typeof v !== 'number') return String(v);
  if (v !== 0 && Math.abs(v) < 0.0001) return v.toExponential().replace(/\.?0+e/, 'e').replace('e-0', 'e-');
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US');
  return String(Number(v.toPrecision(6)));
}

function value(e, v) {
  switch (e.type) {
    case 'bool': return v ? 'on' : 'off';
    case 'gradient': return v.length + ' stops';
    case 'file': return v ? v.name : '\u2014';
    case 'number':
    case 'int': return num(v);
    default: return String(v);
  }
}

function range(e) {
  switch (e.type) {
    case 'number':
    case 'int': return num(e.min) + '\u2013' + num(e.max) + (e.scale === 'log' ? ' (log)' : '') + (e.unit ? ' ' + e.unit : '');
    case 'enum': return e.options.join(', ');
    case 'gradient': return '\u2264 ' + e.maxStops + ' stops';
    default: return e.type;
  }
}

function condition(c) {
  if (c.any) return c.any.map(condition).join(' or ');
  const e = SCHEMA_BY_ID.get(c.id);
  if ('is' in c) return e.label + ' ' + (e.type === 'bool' ? (c.is ? 'on' : 'off') : (e.optionLabels && e.optionLabels[c.is]) || c.is);
  if ('ne' in c) return e.label + ' not ' + ((e.optionLabels && e.optionLabels[c.ne]) || c.ne);
  if ('gt' in c) return e.label + ' above ' + num(c.gt);
  if (c.notNull) return 'a ' + e.label + ' loaded';
  return '';
}

function changes(e) {
  // Only values that differ from the default (a look may repeat a default inside a bundle).
  const differs = (v) => JSON.stringify(v) !== JSON.stringify(e.default);
  const out = [];
  for (const name of LOOKS) {
    if (Object.hasOwn(LOOK_PRESETS[name], e.id) && differs(LOOK_PRESETS[name][e.id])) out.push(name + ' ' + value(e, LOOK_PRESETS[name][e.id]));
  }
  for (const name of QUALITY_ORDER) {
    if (Object.hasOwn(QUALITY_PRESETS[name], e.id) && differs(QUALITY_PRESETS[name][e.id])) out.push(name + ' ' + value(e, QUALITY_PRESETS[name][e.id]));
  }
  return out.length ? out.join('; ') : '\u2014';
}

function notes(e) {
  const flags = [];
  if (e.preset === false) flags.push('personal preference');
  if (e.webgpu) flags.push('WebGPU only');
  if (e.rebuild !== 'none') flags.push('rebuilds ' + e.rebuild);
  let text = (flags.length ? flags.join(', ') + '. ' : '') + e.help;
  if (e.needs) text += ' Has an effect with ' + e.needs.map(condition).join(' and ') + '.';
  return text.replace(/\|/g, '\\|');
}

const lines = [];
for (const g of GROUPS) {
  const list = SCHEMA.filter((e) => e.group === g.id);
  if (!list.length) continue;
  lines.push('### ' + g.label, '', '| Setting | Range / options | Default (Landscape, High) | Looks and quality that change it | Notes |', '|---|---|---|---|---|');
  for (const e of list) {
    lines.push('| ' + e.label + ' <br><code>' + e.id + '</code> | ' + range(e) + ' | ' + value(e, e.default) + ' | ' + changes(e) + ' | ' + notes(e) + ' |');
  }
  lines.push('');
}
process.stdout.write(lines.join('\n'));
