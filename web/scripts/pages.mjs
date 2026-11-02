// Extra pages for the screenshot gate, contributed per phase. `json(path)` fetches from the server.
export async function pages() {
  return [{ name: 'more', path: '/more' }];
}
