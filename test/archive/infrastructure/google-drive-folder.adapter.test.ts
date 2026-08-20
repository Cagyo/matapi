import { describe, expect, it, vi } from "vitest";
import type { DriveConnection } from "../../../src/archive/domain/drive-connection.entity";
import { GoogleDriveFolderAdapter } from "../../../src/archive/infrastructure/google/google-drive-folder.adapter";

const sdk = vi.hoisted(() => ({
  listInput: null as Record<string, unknown> | null,
  getInput: null as Record<string, unknown> | null,
  createInput: null as Record<string, unknown> | null,
  generateInput: null as Record<string, unknown> | null,
  listResponse: { files: [], nextPageToken: null, incompleteSearch: false },
  getResponse: null as Record<string, unknown> | Error | null,
  createResponse: null as Record<string, unknown> | Error,
  generatedIds: ["folder-generated"] as string[],
}));

vi.mock("@googleapis/drive", () => ({
  auth: {
    OAuth2: class {
      setCredentials(): void {
        return undefined;
      }
    },
  },
  drive: () => ({
    files: {
      list: async (input: Record<string, unknown>) => {
        sdk.listInput = input;
        if (sdk.listResponse instanceof Error) throw sdk.listResponse;
        return { data: sdk.listResponse };
      },
      get: async (input: Record<string, unknown>) => {
        sdk.getInput = input;
        if (sdk.getResponse instanceof Error) throw sdk.getResponse;
        if (sdk.getResponse === null) throw providerFailure(404, "notFound");
        return { data: sdk.getResponse };
      },
      create: async (input: Record<string, unknown>) => {
        sdk.createInput = input;
        if (sdk.createResponse instanceof Error) throw sdk.createResponse;
        return { data: sdk.createResponse };
      },
      generateIds: async (input: Record<string, unknown>) => {
        sdk.generateInput = input;
        return { data: { ids: sdk.generatedIds } };
      },
    },
  }),
}));

const signal = new AbortController().signal;

describe("GoogleDriveFolderAdapter", () => {
  it("issues a parent-constrained date property query and returns exact metadata", async () => {
    resetSdk();
    sdk.listResponse = {
      files: [folder("month-1", "2026-08", "year-1")],
      nextPageToken: "next-page",
      incompleteSearch: false,
    };
    const adapter = adapterFor();

    await expect(adapter.listCandidates({
      connection: connection(),
      parentId: "year-1",
      role: "motion-month",
      normalizedPath: "2026/08",
      pageToken: null,
      pageSize: 100,
    }, signal)).resolves.toEqual({
      folders: [{
        id: "month-1",
        name: "2026-08",
        mimeType: "application/vnd.google-apps.folder",
        parentIds: ["year-1"],
        appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: "motion-month", a1p: "2026/08" },
        ownedByMe: true,
        ownerPermissionIds: ["perm-1"],
        permissionIds: ["perm-1"],
        shared: false,
        trashed: false,
      }],
      nextPageToken: "next-page",
      incompleteSearch: false,
    });

    expect(sdk.listInput?.q).toContain("'year-1' in parents");
    expect(sdk.listInput?.q).toContain("key='a1p' and value='2026/08'");
    expect(sdk.listInput?.pageSize).toBe(100);
    expect(String(sdk.listInput?.fields)).toContain("mimeType,parents,appProperties");
    expect(String(sdk.listInput?.fields)).toContain("owners(permissionId),permissionIds,shared,trashed");
  });

  it("loads exact folder metadata and creates a folder with its reserved ID", async () => {
    resetSdk();
    sdk.getResponse = folder("existing-1", "Existing", "year-1");
    sdk.createResponse = folder("reserved-1", "August", "year-1");
    const adapter = adapterFor();

    await expect(adapter.loadExact(connection(), "existing-1", signal)).resolves.toMatchObject({
      id: "existing-1", name: "Existing", parentIds: ["year-1"], ownerPermissionIds: ["perm-1"],
    });
    await expect(adapter.generateId(connection(), signal)).resolves.toBe("folder-generated");
    await expect(adapter.create({
      connection: connection(),
      id: "reserved-1",
      parentId: "year-1",
      name: "August",
      appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: "motion-month", a1p: "2026/08" },
    }, signal)).resolves.toMatchObject({ id: "reserved-1", name: "August" });

    expect(sdk.getInput?.fields).toBeDefined();
    expect(String(sdk.getInput?.fields)).toContain("id,name,mimeType,parents,appProperties");
    expect(String(sdk.getInput?.fields)).toContain("ownedByMe,owners(permissionId),permissionIds,shared,trashed");
    expect(sdk.generateInput).toMatchObject({ count: 1, space: "drive", fields: "ids" });
    expect(sdk.createInput).toMatchObject({ ignoreDefaultVisibility: true });
    expect(sdk.createInput?.requestBody).toMatchObject({
      id: "reserved-1",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["year-1"],
      appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: "motion-month", a1p: "2026/08" },
    });
  });

  it.each([
    ["a mismatched ID", folder("unexpected-folder", "Existing", "year-1")],
    ["a missing ID", { ...folder("existing-1", "Existing", "year-1"), id: undefined }],
  ])("rejects %s returned from an exact folder load", async (_case, response) => {
    resetSdk();
    sdk.getResponse = response;

    await expect(adapterFor().loadExact(connection(), "existing-1", signal)).rejects.toMatchObject({
      name: "DriveFolderExactIdIntegrityError",
      code: "DRIVE_FOLDER_EXACT_ID_INTEGRITY",
      message: "Google Drive folder exact-ID integrity check failed",
    });
  });

  it.each([
    ["a mismatched ID", folder("unexpected-folder", "August", "year-1")],
    ["a missing ID", { ...folder("reserved-1", "August", "year-1"), id: undefined }],
  ])("rejects %s returned from a reserved folder create", async (_case, response) => {
    resetSdk();
    sdk.createResponse = response;

    await expect(adapterFor().create({
      connection: connection(),
      id: "reserved-1",
      parentId: "year-1",
      name: "August",
      appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: "motion-month", a1p: "2026/08" },
    }, signal)).rejects.toMatchObject({
      name: "DriveFolderExactIdIntegrityError",
      code: "DRIVE_FOLDER_EXACT_ID_INTEGRITY",
      message: "Google Drive folder exact-ID integrity check failed",
    });
  });

  it("maps a rejected page token without exposing the provider message", async () => {
    resetSdk();
    sdk.listResponse = providerFailure(400, "badRequest", "page token=secret-token is invalid");
    const adapter = adapterFor();

    await expect(adapter.listCandidates({
      connection: connection(), parentId: "year-1", role: "motion-month", normalizedPath: "2026/08", pageToken: "secret-token", pageSize: 100,
    }, signal)).rejects.toMatchObject({
      name: "DriveFolderPageTokenRejectedError",
      code: "DRIVE_FOLDER_PAGE_TOKEN_REJECTED",
      message: "Google Drive folder page token was rejected",
    });
    await expect(adapter.listCandidates({
      connection: connection(), parentId: "year-1", role: "motion-month", normalizedPath: "2026/08", pageToken: "secret-token", pageSize: 100,
    }, signal)).rejects.not.toThrow(/secret-token/);
  });
});

function adapterFor(): GoogleDriveFolderAdapter {
  return new GoogleDriveFolderAdapter({
    loadCredentials: async () => ({
      client: { clientId: "client-id", clientSecret: "client-secret" },
      tokens: { accessToken: "access", refreshToken: "refresh", expiryDateMs: null, tokenType: "Bearer", scope: null },
      revision: 1,
    }),
  });
}

function connection(): DriveConnection {
  return { id: "generation-1", installationId: "installation-1" } as DriveConnection;
}

function folder(id: string, name: string, parentId: string): Record<string, unknown> {
  return {
    id,
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
    appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: "motion-month", a1p: "2026/08" },
    ownedByMe: true,
    owners: [{ permissionId: "perm-1" }],
    permissionIds: ["perm-1"],
    shared: false,
    trashed: false,
  };
}

function providerFailure(status: number, reason: string, message = "provider failure"): Error {
  return Object.assign(new Error(message), { response: { status, data: { error: { message, errors: [{ reason }] } } } });
}

function resetSdk(): void {
  sdk.listInput = null;
  sdk.getInput = null;
  sdk.createInput = null;
  sdk.generateInput = null;
  sdk.listResponse = { files: [], nextPageToken: null, incompleteSearch: false };
  sdk.getResponse = null;
  sdk.createResponse = folder("created-1", "Created", "year-1");
  sdk.generatedIds = ["folder-generated"];
}
