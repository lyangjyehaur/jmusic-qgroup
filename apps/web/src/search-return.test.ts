import { expect, it } from 'vitest';
import { searchReturn } from './search-return';

it('retains complete local search context while rejecting foreign, malformed and ambiguous return destinations', () => {
  for (const value of ['/search?q=music', '/search?q=%E9%9F%B3%E6%A8%82&group=people&page=2', '/search?q=a%26b%3Dc']) expect(searchReturn(value)).toBe(value);
  for (const value of [null, '', 'https://outside.example/search?q=x', '//outside.example/search?q=x', '/search', '/search?q=', '/search?q=x#token', '/search?q=x&next=https://outside.example', '/search?q=x&q=y', '/search?q=x&page=2', '/search/../search?q=x', '/search?q=x&group=people&page=0']) expect(searchReturn(value)).toBeNull();
});
