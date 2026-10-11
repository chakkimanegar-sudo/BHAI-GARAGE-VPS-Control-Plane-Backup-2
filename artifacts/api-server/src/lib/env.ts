const PLACEHOLDER_SECRET_PATTERN =
  /(?:replace[_ -]?with|change[_ -]?me|changeme|placeholder|your[_ -]?(?:secret|token|password)|not[-_ ]for[-_ ]production)/i;

function validateSecret(name: string, value: string | undefined): void {
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters; generate a fresh random secret.`);
  }
  if (PLACEHOLDER_SECRET_PATTERN.test(value) || new Set(value).size < 8) {
    throw new Error(`${name} appears to be a placeholder or low-diversity value; replace it with a fresh random secret.`);
  }
}

/**
 * Fail before listening when an example or weak authentication secret is still
 * configured. Never include the supplied secret in errors or logs.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  validateSecret("SESSION_SECRET", env.SESSION_SECRET);
  validateSecret("BHAI_SETUP_TOKEN", env.BHAI_SETUP_TOKEN);
}
