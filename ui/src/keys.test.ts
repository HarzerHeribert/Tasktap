// Keys as each system has them (keys.ts): the Mac's as written, Windows' by its rule.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APP_KEYS } from '../../core/proto/protocol.ts';
import { COMMANDS, accelerator, answerUsual, commands, hit, holds, keyName, learnLayout, links, local, ours, spell } from './keys.ts';
import { plain, shownPath } from './system.ts';

// Stand-ins for the layout map a web view gives (what each key prints, by its place): a German keyboard's and a US one.
const DE = { KeyQ: 'q', KeyE: 'e', KeyJ: 'j', KeyY: 'z', KeyZ: 'y', Digit1: '1', Minus: 'ß', Equal: '´', BracketLeft: 'ü', BracketRight: '+', Backslash: '#',
  Semicolon: 'ö', Quote: 'ä', Backquote: '^', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<', Space: ' ' };
const US = { KeyQ: 'q', KeyE: 'e', KeyJ: 'j', KeyY: 'y', KeyZ: 'z', Digit1: '1', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/' };

test("a key bound by its place is named as the person's keyboard prints it, and still matched by its place", () => {
  const alt = (code: string) => ({ control: false, alt: true, shift: false, meta: false, code });
  try {
    // Before a layout is known: as a US keyboard prints it.
    assert.equal(keyName(alt('KeyZ'), true), '⌥Z');
    assert.equal(learnLayout(DE), true);
    for (const [code, onMac, onWindows] of [['KeyZ', '⌥Y', 'Alt+Y'], ['KeyY', '⌥Z', 'Alt+Z'], ['Minus', '⌥ß', 'Alt+ß'], ['BracketLeft', '⌥Ü', 'Alt+Ü'], ['Semicolon', '⌥Ö', 'Alt+Ö'],
      ['Quote', '⌥Ä', 'Alt+Ä'], ['Equal', '⌥´', 'Alt+´'], ['Backquote', '⌥^', 'Alt+^'], ['BracketRight', '⌥+', 'Alt++'], ['Slash', '⌥-', 'Alt+-'], ['IntlBackslash', '⌥<', 'Alt+<'],
      ['Space', '⌥Space', 'Alt+Space'], ['KeyJ', '⌥J', 'Alt+J'], ['Digit1', '⌥1', 'Alt+1']] as const) {
      assert.equal(keyName(alt(code), true), onMac, code);
      assert.equal(keyName(alt(code), false), onWindows, code);
    }
    // The keys that answer from any app, by their places: on a German keyboard the place of a US Y says Z.
    assert.equal(keyName(answerUsual('question', true), true), '⌃⌥J');
    assert.equal(keyName(answerUsual('yes', true), true), '⌃⌥Z');
    assert.equal(keyName(answerUsual('no', false), false), 'Alt+Shift+N');
    assert.equal(keyName(answerUsual('yes', false), false), 'Alt+Shift+Z');
    assert.equal(spell(keyName(answerUsual('question', false), false), false), 'Alt+Shift+J');
    // The same layout again changes nothing; a US one changes the names back.
    assert.equal(learnLayout(new Map(Object.entries(DE))), false);
    assert.equal(learnLayout(US), true);
    assert.equal(keyName(answerUsual('yes', true), true), '⌃⌥Y');
    for (const [code, said] of [['KeyZ', '⌥Z'], ['Minus', '⌥-'], ['BracketLeft', '⌥['], ['Semicolon', '⌥;'], ['Quote', "⌥'"], ['Backquote', '⌥`']] as const) assert.equal(keyName(alt(code), true), said);
    // Whatever it is called, a recorded key is the key in that place.
    learnLayout(DE);
    const press = { code: 'KeyZ', key: 'y', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false } as KeyboardEvent;
    assert.ok(holds(press, alt('KeyZ')) && !holds(press, alt('KeyY')));
  } finally {
    learnLayout(null);
  }
  assert.equal(keyName(alt('KeyZ'), true), '⌥Z');
});

const press = (key: string, held = '') => ({ key, ctrlKey: held.includes('c'), altKey: held.includes('a'), shiftKey: held.includes('s'), metaKey: held.includes('m') });

test('a Mac shows a key as it is written, its modifiers in its own order', () => {
  for (const [k, said] of [['⌘T', '⌘T'], ['⌘⇧D', '⇧⌘D'], ['⌘⌃S', '⌃⌘S'], ['⌘⌫', '⌘⌫'], ['⌥Space', '⌥Space'], ['esc', 'esc'], ['↩', '↩'], ['⌘1', '⌘1'], ['⌘↓', '⌘↓']] as const)
    assert.equal(spell(k, true), said);
});

test('Windows has Control for Command, with Shift where the key is a letter', () => {
  for (const [k, said] of [['⌘T', 'Ctrl+Shift+T'], ['⌘N', 'Ctrl+Shift+N'], ['⌘O', 'Ctrl+Shift+O'], ['⌘W', 'Ctrl+Shift+W'], ['⌘F', 'Ctrl+Shift+F'], ['⌘D', 'Ctrl+Shift+D'], ['⌃⌘S', 'Ctrl+Shift+S'],
    ['⌘I', 'Ctrl+Shift+I'], ['⌘R', 'Ctrl+Shift+R'], ['⌘P', 'Ctrl+Shift+P'], ['⌘C', 'Ctrl+Shift+C'], ['⌘V', 'Ctrl+Shift+V'],
    ['⌘,', 'Ctrl+,'], ['⌘=', 'Ctrl+='], ['⌘-', 'Ctrl+-'], ['⌘0', 'Ctrl+0'], ['⌘1', 'Ctrl+1'], ['⌘⌫', 'Ctrl+Backspace'], ['⌘↩', 'Ctrl+↩']] as const)
    assert.equal(spell(k, false), said);
});

test('a few keys are as Windows itself has them', () => {
  for (const [k, said] of [['⇧⌘D', 'Ctrl+Shift+E'], ['⌘⇧D', 'Ctrl+Shift+E'], ['⇧⌘N', 'Ctrl+Shift+M'], ['⌘[', 'Alt+←'], ['⌘↓', 'Ctrl+End'], ['⌘Z', 'Ctrl+Z']] as const) assert.equal(spell(k, false), said);
});

test('a key without Command is the same key, in the words Windows prints', () => {
  for (const [k, said] of [['esc', 'Esc'], ['↩', '↩'], ['⇧↩', 'Shift+↩'], ['⌥Space', 'Alt+Space'], ['1', '1'], ['t', 'T'], ['Ctrl+Alt+Space', 'Ctrl+Alt+Space'], ['Ctrl+Shift', 'Ctrl+Shift']] as const)
    assert.equal(spell(k, false), said);
});

test('no two commands share a key on either system', () => {
  // The menu's commands and the Composer's own: ⌘K the place's list, ⌘J the agent control's (rings.tsx AGENT_KEY).
  const all = ['⌘N', '⇧⌘N', '⌘T', '⌘O', '⌘W', '⌘F', '⌘D', '⇧⌘D', '⌃⌘S', '⌘I', '⌘R', '⌘P', '⌘C', '⌘V', '⌘,', '⌘=', '⌘-', '⌘0', '⌘[', '⌘↓', '⌘Z', '⌘⌫', '⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘K', '⌘J'];
  for (const onMac of [true, false]) assert.equal(new Set(all.map((k) => spell(k, onMac))).size, all.length);
});

test('Settings\' sections are on ⌘1 to ⌘7 in the order of their list (Ctrl+1 to Ctrl+7 on Windows)', () => {
  // The list as settings.tsx has it, read as text: that page needs a web view to run.
  const source = readFileSync(new URL('./workspace/settings.tsx', import.meta.url), 'utf8');
  const names = [.../export const SECTIONS = \[(.*?)\] as const;/.exec(source)![1]!.matchAll(/\['[a-z]+', '([A-Za-z]+)'\]/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Tasks', 'Agents', 'Projects', 'Voice', 'Appearance', 'Terminal', 'About']);
  assert.deepEqual(names.map((_, i) => spell(`⌘${i + 1}`, true)), ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7']);
  assert.deepEqual(names.map((_, i) => spell(`⌘${i + 1}`, false)), ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7']);
  names.forEach((_, i) => assert.ok(hit(`⌘${i + 1}`, press(String(i + 1), 'm'), true) && hit(`⌘${i + 1}`, press(String(i + 1), 'c'), false)));
});

test('a key press is a command by this system\'s key and no other', () => {
  assert.ok(hit('⌘T', press('t', 'm'), true));
  assert.ok(!hit('⌘T', press('T', 'ms'), true));
  assert.ok(!hit('⌘T', press('t', 'c'), true));
  assert.ok(hit('⌘T', press('T', 'cs'), false));
  // Control with the letter alone is the terminal program's.
  assert.ok(!hit('⌘T', press('t', 'c'), false));
  assert.ok(!hit('⌘T', press('t', 'm'), false));
  assert.ok(hit('⇧⌘D', press('D', 'ms'), true));
  assert.ok(hit('⇧⌘D', press('E', 'cs'), false));
  assert.ok(hit('⌘D', press('D', 'cs'), false));
  assert.ok(hit('⌘,', press(',', 'c'), false));
  assert.ok(hit('⌘⌫', press('Backspace', 'c'), false));
  assert.ok(hit('⌘⌫', press('Backspace', 'm'), true));
  assert.ok(hit('⌘[', press('ArrowLeft', 'a'), false));
  assert.ok(hit('⌘↓', press('End', 'c'), false));
  assert.ok(hit('⌘↓', press('ArrowDown', 'm'), true));
  assert.ok(hit('⌘Z', press('z', 'c'), false));
  assert.ok(hit('esc', press('Escape'), false) && hit('esc', press('Escape'), true));
  assert.ok(hit('⇧↩', press('Enter', 's'), false));
});

test('in a terminal the app takes Command on a Mac, and Control and Shift with a letter on Windows', () => {
  assert.ok(ours(press('c', 'm'), true));
  assert.ok(!ours(press('c', 'c'), true));
  assert.ok(ours(press('C', 'cs'), false));
  assert.ok(!ours(press('c', 'c'), false));
  assert.ok(!ours(press('ArrowLeft', 'cs'), false));
  assert.ok(commands(press('t', 'm'), true) && !commands(press('t', 'mc'), true) && commands(press('T', 'cs'), false) && !commands(press('t', 'ca'), false));
  assert.ok(links({ metaKey: true, ctrlKey: false }, true) && !links({ metaKey: true, ctrlKey: false }, false) && links({ metaKey: false, ctrlKey: true }, false));
});

test('a recorded shortcut is shown as the keys themselves', () => {
  const s = (held: string, code: string) => ({ control: held.includes('c'), alt: held.includes('a'), shift: held.includes('s'), meta: held.includes('m'), code });
  assert.equal(keyName(s('as', 'Space'), true), '⌥⇧Space');
  assert.equal(keyName(s('as', 'Space'), false), 'Alt+Shift+Space');
  assert.equal(keyName(s('ca', 'KeyT'), true), '⌃⌥T');
  assert.equal(keyName(s('ca', 'KeyT'), false), 'Ctrl+Alt+T');
  assert.equal(keyName(s('m', 'Escape'), false), 'Win+Esc');
  assert.equal(keyName(s('c', 'Space'), false), 'Ctrl+Space');
  // Shown through `Key`, it stays what it is.
  assert.equal(spell(keyName(s('ca', 'KeyT'), false), false), 'Ctrl+Alt+T');
  assert.equal(spell(keyName(s('cm', 'KeyT'), true), true), '⌃⌘T');
});

test('a menu item takes a key in the host\'s words', () => {
  assert.equal(accelerator('⌘T', true), 'CmdOrCtrl+T');
  assert.equal(accelerator('⇧⌘D', true), 'Shift+CmdOrCtrl+D');
  assert.equal(accelerator('⌘T', false), 'Ctrl+Shift+T');
  assert.equal(accelerator('⌘,', false), 'Ctrl+,');
  assert.equal(accelerator('⌘[', false), 'Alt+ArrowLeft');
});

test('a path is shown without the prefix of a canonical one', () => {
  assert.equal(plain('\\\\?\\C:\\Users\\someone\\project'), 'C:\\Users\\someone\\project');
  assert.equal(plain('\\\\?\\UNC\\server\\share\\project'), '\\\\server\\share\\project');
  assert.equal(plain('C:\\Users\\someone'), 'C:\\Users\\someone');
  assert.equal(shownPath('/Users/someone/projects/cuegrid'), '~/projects/cuegrid');
  assert.equal(shownPath('\\\\?\\C:\\Users\\someone\\project'), 'C:\\Users\\someone\\project');
});

test('the table of Tasktap\'s own keys says what this file says, on both systems', () => {
  // The core spells and places each command's key by its own port of `local` and `spell`: the two agree.
  for (const c of APP_KEYS) {
    for (const onMac of [true, false]) {
      const says = onMac ? c.says.mac : c.says.windows, at = onMac ? c.mac : c.windows, l = local(c.key, onMac);
      assert.equal(spell(c.key, onMac), says, c.key);
      assert.deepEqual([l.control, l.alt, l.shift, l.meta], [at.control, at.alt, at.shift, at.meta], `${c.key} ${onMac ? 'Mac' : 'Windows'}`);
    }
  }
  // The menu's commands are the table's.
  assert.deepEqual(Object.keys(COMMANDS), ['new-task', 'new-terminal', 'open-workspace', 'pop-out', 'close-tab', 'find', 'sidebar', 'split-right', 'split-down', 'preview', 'reload-preview', 'bigger', 'smaller', 'reset', 'settings', 'back', 'session']);
  assert.equal(COMMANDS['split-down'], '⇧⌘D');
});
