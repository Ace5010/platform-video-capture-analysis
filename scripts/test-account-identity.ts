import assert from 'node:assert/strict';
import { canonicalDouyinAccountUrl } from '../lib/account-identity.ts';

const canonical = 'https://www.douyin.com/user/MS4w.Test-profile';
for (const url of [canonical, `${canonical}?nt=1`, `${canonical}?nt=2#works`,
  'http://douyin.com/user/MS4w.Test-profile/', 'https://m.douyin.com/user/MS4w.Test%2Dprofile?from=follow']) {
  assert.equal(canonicalDouyinAccountUrl(url), canonical);
}
assert.notEqual(canonicalDouyinAccountUrl('https://www.douyin.com/user/another-profile'), canonical);
for (const url of ['https://evildouyin.com/user/a', 'https://douyin.com.evil.test/user/a',
  'https://www.douyin.com/video/123', 'https://www.douyin.com/user/', 'javascript:alert(1)',
  'https://user:secret@www.douyin.com/user/a', 'https://www.douyin.com:3000/user/a',
  'https://www.douyin.com/user/a/b', 'https://www.douyin.com/user/a%2Fb']) {
  assert.equal(canonicalDouyinAccountUrl(url), null, url);
}
console.log('Account identity passed: referral variants, canonical profiles, distinct IDs and invalid URLs.');
