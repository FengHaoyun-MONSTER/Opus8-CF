import { fileURLToPath } from "node:url";

export function validateControlDeployEnvironment(environment = process.env) {
  const errors = [];
  const add = (name, message) => errors.push({ name, message });
  const value = (name) => String(environment[name] ?? "");

  const rootDomain = value("ROOT_DOMAIN")
    .replace(/^https?:\/\//i, "")
    .split("/", 1)[0];
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i.test(rootDomain)) {
    add("ROOT_DOMAIN", "must contain a valid DNS root domain");
  }
  validateSecret(environment, errors, "ADMIN_PASSWORD", 8);
  validateSecret(environment, errors, "JWT_SECRET", 24);
  validateSecret(environment, errors, "NODE_HMAC_SECRET", 32);
  validateSecret(environment, errors, "FREEDOMPOST_INTEGRATION_SECRET", 32);

  if (!/^[A-Za-z0-9._-]{3,64}$/.test(value("FREEDOMPOST_INTEGRATION_KEY_ID"))) {
    add("FREEDOMPOST_INTEGRATION_KEY_ID", "contains an invalid key ID");
  }
  if (!validBase64UrlKey(value("LANDING_CONFIG_KEY"))) {
    add("LANDING_CONFIG_KEY", "must be a canonical base64url-encoded 256-bit key");
  }
  return errors;
}

export function formatControlDeployErrors(errors) {
  return errors.map(({ name, message }) => `ERROR ${name}: ${message}`).join("\n");
}

function validateSecret(environment, errors, name, minimum) {
  const secret = String(environment[name] ?? "");
  if (secret.length < minimum || secret.length > 4_096 || /[\r\n]/.test(secret)) {
    errors.push({
      name,
      message: `must contain ${minimum} to 4096 characters without line breaks`
    });
  }
}

function validBase64UrlKey(input) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input)) return false;
  const decoded = Buffer.from(input, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === input;
}

function runCli() {
  const errors = validateControlDeployEnvironment(process.env);
  if (errors.length === 0) {
    process.stdout.write("OK control-deploy-preflight\n");
    return;
  }
  process.stderr.write(`${formatControlDeployErrors(errors)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runCli();
