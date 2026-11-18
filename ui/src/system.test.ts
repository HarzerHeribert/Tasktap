// What differs between the systems, where it is arithmetic on a path (system.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { asAddress, plain } from './system.ts';

test('a path of Windows is shown without the prefix of a canonical one', () => {
  assert.equal(plain('\\\\?\\C:\\Users\\me\\app'), 'C:\\Users\\me\\app');
  assert.equal(plain('\\\\?\\UNC\\server\\share\\app'), '\\\\server\\share\\app');
  assert.equal(plain('/Users/me/app'), '/Users/me/app');
});

test("a file's path as an address: a slash before the drive and slashes throughout on Windows, as it is on a Mac", () => {
  assert.equal(asAddress('C:\\Users\\me\\app\\report.html', true), '/C:/Users/me/app/report.html');
  assert.equal(asAddress('\\\\?\\C:\\Users\\me\\app\\report.html', true), '/C:/Users/me/app/report.html');
  assert.equal(asAddress('\\\\server\\share\\report.html', true), '//server/share/report.html');
  // What the page names beside itself is then beside it.
  assert.equal(new URL('shot.png', 'http://127.0.0.1:1/token' + asAddress('C:\\app\\out\\report.html', true)).pathname, '/token/C:/app/out/shot.png');
  assert.equal(asAddress('/Users/me/app/a\\b.html', false), '/Users/me/app/a\\b.html');
});
