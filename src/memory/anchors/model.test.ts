import { describe, expect, it } from 'vitest';
import { emptyData, replay, render, sourceRef, signature, type Entry, type Event, type Source } from './model';
const s1: Source = { id: 'a', floor: 20, text: '争吵' };
const s2: Source = { id: 'b', floor: 24, text: '和好' };
const entry = (value: string | null): Entry => ({ id: 'relationship_status:Stage', module: 'relationship_status', key: 'Stage', value, date: '' });
const event = (value: string, source: Source, order = 1): Event => ({ id: String(order), entry: entry(value), sources: [sourceRef(source)], order, manual: false });
describe('highlight event replay and injection', () => {
  it('removing an old argument never discards a later reconciliation', () => {
    const d = emptyData(); d.events = [event('冷战', s1), event('稳定', s2, 2)];
    expect(replay(d, [s2]).get(entry('').id)?.value).toBe('稳定');
    expect(replay(d, [s1]).get(entry('').id)?.value).toBe('冷战');
    expect(replay(d, []).size).toBe(0);
  });
  it('resummarizing an older floor does not overwrite newer state', () => {
    const d = emptyData(); d.events = [event('稳定', s2, 1), event('摩擦', s1, 10)];
    expect(replay(d, [s1, s2]).get(entry('').id)?.value).toBe('稳定');
  });
  it('source edits invalidate automatic events but preserve explicit manual records', () => {
    const d = emptyData(); d.events = [event('冷战', s1)];
    expect(replay(d, [{ ...s1, text: '并未争吵' }]).size).toBe(0);
    d.events[0].manual = true;
    expect(replay(d, []).get(entry('').id)?.value).toBe('冷战');
  });
  it('stores fingerprints and location instead of duplicate summary/evidence', () => {
    expect(sourceRef(s1).text).toBe('');
    expect(sourceRef(s1).fingerprint).toBeTruthy();
  });
  it('hidden reference is retained internally but never expanded into the prompt', () => {
    const d = emptyData(); d.enabled = true;
    const t: Entry = { id: 'evt_1', module: 'long_term_timeline', key: '', value: '吵架', date: '' };
    d.events = [{ ...event('冷战', s1), entry: { ...entry('冷战'), ref: t.id } }, { ...event('', s1, 2), entry: t }];
    d.policies[t.id] = { visible: false, control: 'SUGGEST' };
    expect(render(d, [s1]).relationship_status).toContain('冷战');
    expect(render(d, [s1]).relationship_status).not.toContain('Ref:');
    expect(render(d, [s1]).long_term_timeline).toBe('');
    expect(replay(d, [s1]).get(entry('').id)?.ref).toBe(t.id);
    d.policies[t.id].visible = true;
    expect(render(d, [s1]).relationship_status).toContain('Ref:evt_1');
  });
  it('module toggles and master switch preserve individual visibility', () => {
    const d = emptyData(); d.enabled = true; d.events = [event('稳定', s2)];
    d.modules.relationship_status = false;
    expect(render(d, [s2]).relationship_status).toBe('');
    d.modules.relationship_status = true;
    expect(render(d, [s2]).relationship_status).toContain('稳定');
    d.display = false;
    expect(Object.values(render(d, [s2])).join('')).toBe('');
    expect(replay(d, [s2]).size).toBe(1);
  });
  it('explicit null clears and does not emit an empty key', () => {
    const d = emptyData(); d.enabled = true; d.events = [event('冷战', s1), { ...event('', s2, 2), entry: entry(null) }];
    expect(replay(d, [s1, s2]).get(entry('').id)?.value).toBeNull();
    expect(render(d, [s1, s2]).relationship_status).toBe('');
  });
  it('rejected newly generated IDs still match the same content and source', () => {
    const a = event('事实', s1), b = event('事实', s1);
    b.entry.id = 'different';
    expect(signature(a)).toBe(signature(b));
  });
});
