import { search, options } from './server.js';
for (const category of ['news', 'blog', 'reddit', 'humor']) {
    const data = await search(options(new URLSearchParams({ category, period: '30d' })));
    console.log(JSON.stringify({ category, statuses: data.statuses, count: data.items.length, first: data.items[0], htmlLeak: data.items.some(i => /<\/?[a-z][^>]*>|&(?:lt|gt|nbsp);/i.test(i.description)) }));
}
