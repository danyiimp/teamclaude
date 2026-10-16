import { importCredentials } from './oauth.js';
import { importCodexCredentials, DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { providerOf } from './provider.js';

/**
 * The file an OAuth entry reads its tokens from, or null when it holds its own:
 * `importFrom`, or for a Codex entry with no token the Codex CLI's own file. A
 * default, not an override: that file holds ONE ChatGPT login, and importing it
 * over an account that has its own credential collapsed every Codex row onto
 * that login, discarding what `teamclaude login --codex` had stored.
 * @param {Record<string, any>} acct
 * @returns {string|null}
 */
export function credentialFile(acct) {
  if (acct.type !== 'oauth') return null;
  return acct.importFrom || (providerOf(acct) === 'codex' && !acct.accessToken ? DEFAULT_CODEX_CREDENTIALS_PATH : null);
}

/**
 * Read an entry's tokens from `from` with its provider's reader.
 * @param {Record<string, any>} acct
 * @param {string} from
 * @returns {Promise<Record<string, any>>}
 */
export function importAccountCredentials(acct, from) {
  return providerOf(acct) === 'codex' ? importCodexCredentials(from) : importCredentials(from);
}

/**
 * Turn configured accounts into the objects the AccountManager is built from:
 * `importFrom` entries have their credentials read from disk, and entries with
 * no usable credential are dropped with a message.
 *
 * Config fields are carried through verbatim — the import supplies ONLY the
 * credential fields. Rebuilding an imported account as `{ name, type, ...creds }`
 * used to discard everything else on it (`disabled`, `priority`, `upstream`,
 * `modelMap`, `models`), so an account disabled on disk silently rejoined
 * rotation on every restart and a third-party backend lost its upstream.
 * @param {{ accounts: Array<Record<string, any>> }} config
 */
export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      // A Codex account defaults to the Codex CLI's own credentials file, so
      // `{ "name": "...", "type": "oauth", "provider": "codex" }` is enough to
      // pool an already-signed-in Codex login (see credentialFile).
      const from = credentialFile(acct);
      if (from) {
        try {
          const creds = await importAccountCredentials(acct, from);
          // A readable file with no token is as unusable as a missing one; the
          // non-import branch below already refuses that case, and pushing it
          // anyway would send `Bearer undefined` upstream on every request.
          if (!creds.accessToken) {
            console.error(`No token in ${from} for "${acct.name}", skipping`);
            continue;
          }
          accounts.push({ ...acct, ...creds });
          console.log(`Imported "${acct.name}" from ${from}`);
        } catch (/** @type {any} */ err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}
