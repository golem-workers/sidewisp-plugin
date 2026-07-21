import fs from "node:fs/promises";
import path from "node:path";

const INSTALLATION_ID = /^sw_ins_[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^sw_sec_[A-Za-z0-9_-]{24,256}$/;

function validateCredential(value) {
  if (!value || typeof value !== "object" || !INSTALLATION_ID.test(value.installationId) || !SECRET.test(value.secret)) {
    throw new TypeError("invalid installation credential");
  }
  if (!['active', 'revoked'].includes(value.status)) throw new TypeError("invalid credential status");
  return { installationId: value.installationId, secret: value.secret, status: value.status };
}

export function createFileCredentialStore({ stateDir }) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) throw new TypeError("stateDir must be absolute");
  const directory = path.join(stateDir, "sidewisp");
  const file = path.join(directory, "installation.json");
  return Object.freeze({
    file,
    async read() {
      try {
        const value = validateCredential(JSON.parse(await fs.readFile(file, "utf8")));
        await fs.chmod(directory, 0o700);
        await fs.chmod(file, 0o600);
        return value;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(value) {
      const credential = validateCredential(value);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(credential)}\n`, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
        await fs.chmod(file, 0o600);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
  });
}

export function createEnrollmentManager({ endpoint, store, fetchImpl = globalThis.fetch, clearSetupToken = async () => {} }) {
  let state = "unconfigured";
  let credential = null;
  async function persist(next) {
    await store.write(next);
    credential = next;
    state = next.status === "revoked" ? "revoked" : "active";
  }
  return Object.freeze({
    async load() {
      credential = await store.read();
      state = credential?.status === "revoked" ? "revoked" : credential ? "active" : "unconfigured";
      return state;
    },
    async enroll(setupToken) {
      if (typeof setupToken !== "string" || !setupToken.startsWith("sw_setup_")) throw new TypeError("invalid setup token");
      state = "enrolling";
      try {
        const response = await fetchImpl(new URL("/v1/installations/register", endpoint), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken }),
        });
        if (!response.ok) throw new Error(`enrollment failed (${response.status})`);
        const body = await response.json();
        await persist(validateCredential({ ...body, status: "active" }));
        await clearSetupToken();
        return { installationId: credential.installationId, status: state };
      } catch (error) {
        state = "enrollment-failed";
        throw error;
      }
    },
    async rotate(nextSecret) {
      if (!credential || state !== "active") throw new Error("installation is not active");
      await persist(validateCredential({ ...credential, secret: nextSecret, status: "active" }));
    },
    async revoke() {
      if (!credential) throw new Error("installation is not configured");
      await persist({ ...credential, status: "revoked" });
    },
    canSend: () => state === "active",
    status: () => ({ state, installationId: credential?.installationId ?? null }),
    credential: () => credential && state === "active" ? { ...credential } : null,
  });
}
