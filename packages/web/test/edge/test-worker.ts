/** The edge cache has no Worker of its own under test; the pool needs an entry module. */
// oxlint-disable-next-line import/no-default-export -- a Worker entry module must default-export its handler
export default {
  fetch(): Response {
    return new Response('web edge test worker', { status: 404 });
  },
};
