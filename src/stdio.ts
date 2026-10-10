import { runServer } from './serve.js';
import { storedCredential } from './stored.js';

/** The local server: the same tools as the hosted endpoint, reaching the API over HTTPS with the person's own credential. */
await runServer(process.argv.slice(2), process.env, storedCredential);
