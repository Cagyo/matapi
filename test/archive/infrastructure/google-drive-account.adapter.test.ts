import { describe, expect, it } from "vitest";
import type { DriveConnection } from "../../../src/archive/domain/drive-connection.entity";
import { DriveFolderAmbiguousError } from "../../../src/archive/domain/errors/drive-folder-ambiguous.error";
import { DriveTemporaryUnavailableError } from "../../../src/archive/domain/errors/drive-temporary-unavailable.error";
import { GoogleDriveAccountAdapter } from "../../../src/archive/infrastructure/google/google-drive-account.adapter";
import {
  GoogleDriveGateway,
  type GoogleDriveFolder,
  type GoogleDriveFolderPage,
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

  it("durably reserves each generated folder ID before its provider create", async () => {
    const journal: string[] = [];
    const drive = new DriveStub(journal);
    const reservations = new ReservationStub(journal);
    const adapter = adapterFor(drive, reservations);
    drive.folderPages = [page([]), page([]), page([])];
    drive.generatedIds = ["root-created", "motion-created", "backups-created"];

    await expect(adapter.resolveManagedFolders(connection(), signal)).resolves.toEqual({
      rootId: "root-created",
      motionId: "motion-created",
      backupsId: "backups-created",
    });
    expect(journal).toEqual([
      "reserve:root:root-created", "create:root-created",
      "reserve:motion:motion-created", "create:motion-created",
      "reserve:backups:backups-created", "create:backups-created",
    ]);
  });

  it("recovers a persisted generated ID after the create response is lost", async () => {
    const drive = new DriveStub();
    const reservations = new ReservationStub();
    const adapter = adapterFor(drive, reservations);
    drive.folderPages = [page([])];
    drive.generatedIds = ["root-reserved"];
    drive.createFailures.set("root-reserved", providerFailure(503, "backendError"));

    await expect(adapter.resolveManagedFolders(connection(), signal)).rejects.toThrow(DriveTemporaryUnavailableError);
    expect(reservations.ids).toEqual({ rootId: "root-reserved", motionId: null, backupsId: null });

    drive.files.set("root-reserved", folder("root-reserved", "root", "root"));
    drive.folderPages = [page([folder("motion-folder", "motion", "root-reserved")]), page([folder("backups-folder", "backups", "root-reserved")])];
    await expect(adapter.resolveManagedFolders(connection(), signal)).resolves.toEqual({
      rootId: "root-reserved", motionId: "motion-folder", backupsId: "backups-folder",
    });
    expect(drive.generatedIds).toEqual([]);
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

  it("redacts provider tokens while retaining only a safe failure status and reason", async () => {
    const drive = new DriveStub();
    drive.aboutError = providerFailure(503, "backendError", "access_token=secret-token");
    const adapter = adapterFor(drive);

    await expect(adapter.resolveAccount(connection(), signal)).rejects.toMatchObject({
      name: "DriveTemporaryUnavailableError",
      code: "DRIVE_TEMPORARY_UNAVAILABLE",
      message: "Google Drive request failed (503: backendError)",
    });
  });
});

describe("GoogleDriveGateway", () => {
  it.each([
    ["about", (gateway: GoogleDriveGateway) => gateway.loadAbout(signal)],
    ["list", (gateway: GoogleDriveGateway) => gateway.listFolders({ installationId: "installation-1", generationId: "generation-1", role: "root", parentId: "root", pageToken: null, signal })],
    ["generate", (gateway: GoogleDriveGateway) => gateway.generateFolderId(signal)],
    ["create", (gateway: GoogleDriveGateway) => gateway.createFolder({ id: "folder-1", name: "Folder", role: "root", parentId: "root", appProperties: {}, signal })],
    ["get", (gateway: GoogleDriveGateway) => gateway.loadFolder("folder-1", signal)],
  ])("maps raw provider errors from %s without exposing token-bearing messages", async (_operation, invoke) => {
    const failure = providerFailure(503, "backendError", "refresh_token=secret-token");
    const gateway = new GoogleDriveGateway({
      about: { get: async () => { throw failure; } },
      files: {
        list: async () => { throw failure; },
        generateIds: async () => { throw failure; },
        create: async () => { throw failure; },
        get: async () => { throw failure; },
      },
    } as unknown as ConstructorParameters<typeof GoogleDriveGateway>[0]);

    await expect(invoke(gateway)).rejects.toMatchObject({
      name: "DriveTemporaryUnavailableError",
      code: "DRIVE_TEMPORARY_UNAVAILABLE",
      message: "Google Drive request failed (503: backendError)",
    });
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
  aboutError: Error | null = null;

  constructor(private readonly journal: string[] = []) {}

  async loadAbout(): Promise<typeof this.about> {
    if (this.aboutError) throw this.aboutError;
    return this.about;
  }

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
    this.journal.push(`create:${input.id}`);
    this.created.push(input);
    const failure = this.createFailures.get(input.id);
    if (failure) throw failure;
    const created = folder(input.id, input.role, input.parentId);
    this.files.set(created.id, created);
    return created;
  }
}

class ReservationStub {
  ids = { rootId: null as string | null, motionId: null as string | null, backupsId: null as string | null };
  private revision = 0;

  constructor(private readonly journal: string[] = []) {}

  async loadManagedFolderReservation(): Promise<{ revision: number; rootId: string | null; motionId: string | null; backupsId: string | null }> {
    return { revision: this.revision, ...this.ids };
  }

  async reserveManagedFolder(input: { role: string; folderId: string; expectedRevision: number }): Promise<{ revision: number; rootId: string | null; motionId: string | null; backupsId: string | null } | null> {
    if (input.expectedRevision !== this.revision) return null;
    const key = input.role === "root" ? "rootId" : input.role === "motion" ? "motionId" : "backupsId";
    this.ids[key] = input.folderId;
    this.journal.push(`reserve:${input.role}:${input.folderId}`);
    return { revision: this.revision, ...this.ids };
  }
}

function adapterFor(drive: DriveStub, reservations?: ReservationStub): GoogleDriveAccountAdapter {
  return new GoogleDriveAccountAdapter(drive as unknown as GoogleDriveGateway, (reservations ?? new ReservationStub()) as never);
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

function providerFailure(status: number, reason: string, rawMessage = "provider failure"): Error {
  return Object.assign(new Error(rawMessage), { response: { status, data: { error: { message: rawMessage, errors: [{ reason }] } } } });
}
