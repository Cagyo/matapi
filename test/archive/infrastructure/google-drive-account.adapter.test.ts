import { describe, expect, it } from "vitest";
import type { DriveConnection } from "../../../src/archive/domain/drive-connection.entity";
import { DriveFolderAmbiguousError } from "../../../src/archive/domain/errors/drive-folder-ambiguous.error";
import { GoogleDriveAccountAdapter } from "../../../src/archive/infrastructure/google/google-drive-account.adapter";
import type {
  GoogleDriveGateway,
  GoogleDriveFolder,
  GoogleDriveFolderPage,
} from "../../../src/archive/infrastructure/google/google-drive.gateway";

const signal = new AbortController().signal;

describe("GoogleDriveAccountAdapter", () => {
  it("matches reconnects by permissionId when email is absent", async () => {
    const drive = new DriveStub();
    drive.about = aboutFixture({ permissionId: "perm-1", emailAddress: undefined });
    const adapter = adapterFor(drive);

    await expect(adapter.resolveAccount(connection(), signal)).resolves.toEqual({
      permissionId: "perm-1",
      email: null,
      displayName: "Home owner",
    });
  });

  it("reads string-int64 quota fields and rejects inconsistent quota", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);

    await expect(adapter.readQuota(connection(), signal)).resolves.toEqual({
      limitBytes: null,
      usageBytes: 100,
      usageInDriveBytes: 70,
      usageInDriveTrashBytes: 30,
    });

    drive.about = aboutFixture({
      storageQuota: { limit: "1000", usage: "100", usageInDrive: "80", usageInDriveTrash: "30" },
    });
    await expect(adapter.readQuota(connection(), signal)).rejects.toThrow(DriveFolderAmbiguousError);
  });

  it("reuses all stored folder IDs only after exact metadata validation", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    const saved = connection({ rootId: "root-folder", motionId: "motion-folder", backupsId: "backups-folder" });
    drive.files.set("root-folder", folder("root-folder", "root", "root"));
    drive.files.set("motion-folder", folder("motion-folder", "motion", "root-folder"));
    drive.files.set("backups-folder", folder("backups-folder", "backups", "root-folder"));

    await expect(adapter.resolveManagedFolders(saved, signal)).resolves.toEqual({
      rootId: "root-folder",
      motionId: "motion-folder",
      backupsId: "backups-folder",
    });
    expect(drive.listStarts).toEqual([]);
    expect(drive.created).toEqual([]);
  });

  it("uses private metadata rather than folder names to find an existing folder", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    drive.folderPages = [
      page([folder("root-folder", "root", "root", { name: "not the expected display name" })]),
      page([folder("motion-folder", "motion", "root-folder")]),
      page([folder("backups-folder", "backups", "root-folder")]),
    ];

    await expect(adapter.resolveManagedFolders(connection(), signal)).resolves.toEqual({
      rootId: "root-folder",
      motionId: "motion-folder",
      backupsId: "backups-folder",
    });
    expect(drive.created).toEqual([]);
  });

  it("recovers an uncertain exact-ID folder create without issuing a duplicate create", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    drive.folderPages = [page([]), page([folder("motion-folder", "motion", "root-created")]), page([folder("backups-folder", "backups", "root-created")])];
    drive.generatedIds = ["root-created"];
    drive.createFailures.set("root-created", new Error("request timed out"));
    drive.files.set("root-created", folder("root-created", "root", "root"));

    await expect(adapter.resolveManagedFolders(connection(), signal)).resolves.toEqual({
      rootId: "root-created",
      motionId: "motion-folder",
      backupsId: "backups-folder",
    });
    expect(drive.created.map(({ id }) => id)).toEqual(["root-created"]);
  });

  it("paginates candidates to exhaustion before accepting the only valid match", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    drive.folderPages = [
      page([folder("wrong-owner", "root", "root", { owners: [{ permissionId: "other" }] })], { nextPageToken: "next" }),
      page([folder("root-folder", "root", "root")]),
      page([folder("motion-folder", "motion", "root-folder")]),
      page([folder("backups-folder", "backups", "root-folder")]),
    ];

    await expect(adapter.resolveManagedFolders(connection(), signal)).resolves.toEqual({
      rootId: "root-folder",
      motionId: "motion-folder",
      backupsId: "backups-folder",
    });
    expect(drive.listStarts).toEqual([null, "next", null, null]);
  });

  it("fails closed when two private app-created folder candidates are valid", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    drive.folderPages = [page([folder("folder-a", "root", "root"), folder("folder-b", "root", "root")])];

    await expect(adapter.resolveManagedFolders(connection(), signal)).rejects.toThrow(DriveFolderAmbiguousError);
    expect(drive.deletedIds).toEqual([]);
  });

  it("restarts a rejected page token once and rejects incompleteSearch", async () => {
    const drive = new DriveStub();
    const adapter = adapterFor(drive);
    drive.folderPages = [pageTokenRejected(), page([], { incompleteSearch: true })];

    await expect(adapter.resolveManagedFolders(connection(), signal)).rejects.toThrow(DriveFolderAmbiguousError);
    expect(drive.listStarts).toEqual([null, null]);
  });
});

class DriveStub {
  about = aboutFixture();
  folderPages: Array<GoogleDriveFolderPage | Error> = [];
  files = new Map<string, GoogleDriveFolder>();
  generatedIds: string[] = [];
  createFailures = new Map<string, Error>();
  listStarts: Array<string | null> = [];
  created: Array<{ id: string; role: string; parentId: string }> = [];
  deletedIds: string[] = [];

  async loadAbout(): Promise<typeof this.about> { return this.about; }

  async loadFolder(id: string): Promise<GoogleDriveFolder | null> {
    return this.files.get(id) ?? null;
  }

  async listFolders(input: { pageToken: string | null }): Promise<GoogleDriveFolderPage> {
    this.listStarts.push(input.pageToken);
    const next = this.folderPages.shift() ?? page([]);
    if (next instanceof Error) throw next;
    return next;
  }

  async generateFolderId(): Promise<string> {
    const id = this.generatedIds.shift();
    if (!id) throw new Error("no generated ID configured");
    return id;
  }

  async createFolder(input: { id: string; role: string; parentId: string }): Promise<GoogleDriveFolder> {
    this.created.push(input);
    const failure = this.createFailures.get(input.id);
    if (failure) throw failure;
    const created = folder(input.id, input.role, input.parentId);
    this.files.set(created.id, created);
    return created;
  }
}

function adapterFor(drive: DriveStub): GoogleDriveAccountAdapter {
  return new GoogleDriveAccountAdapter(drive as unknown as GoogleDriveGateway);
}

function connection(folders: { rootId: string; motionId: string; backupsId: string } | null = null): DriveConnection {
  return {
    id: "generation-1",
    installationId: "installation-1",
    permissionId: null,
    folders,
  } as DriveConnection;
}

function aboutFixture(input: {
  permissionId?: string;
  emailAddress?: string | undefined;
  displayName?: string | undefined;
  storageQuota?: { limit?: string | null; usage?: string; usageInDrive?: string; usageInDriveTrash?: string };
} = {}) {
  return {
    user: {
      permissionId: input.permissionId ?? "perm-1",
      emailAddress: "emailAddress" in input ? input.emailAddress : "home@example.test",
      displayName: "displayName" in input ? input.displayName : "Home owner",
    },
    storageQuota: input.storageQuota ?? { limit: null, usage: "100", usageInDrive: "70", usageInDriveTrash: "30" },
  };
}

function folder(
  id: string,
  role: string,
  parentId: string,
  overrides: Partial<GoogleDriveFolder> = {},
): GoogleDriveFolder {
  return {
    id,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
    appProperties: { a1v: "1", a1i: "installation-1", a1g: "generation-1", a1k: role },
    driveId: null,
    ownedByMe: true,
    owners: [{ permissionId: "perm-1" }],
    permissionIds: ["perm-1"],
    shared: false,
    trashed: false,
    name: role,
    ...overrides,
  };
}

function page(
  files: GoogleDriveFolder[],
  options: { nextPageToken?: string | null; incompleteSearch?: boolean } = {},
): GoogleDriveFolderPage {
  return { files, nextPageToken: options.nextPageToken ?? null, incompleteSearch: options.incompleteSearch ?? false };
}

function pageTokenRejected(): Error {
  return Object.assign(new Error("Invalid page token"), { response: { status: 400, data: { error: { message: "Invalid page token" } } } });
}
