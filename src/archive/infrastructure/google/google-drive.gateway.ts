import type { drive_v3 } from "@googleapis/drive";
import { DriveFolderAmbiguousError } from "../../domain/errors/drive-folder-ambiguous.error";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FOLDER_FIELDS = "id,name,mimeType,parents,appProperties,driveId,ownedByMe,owners(permissionId),permissionIds,shared,trashed";

export type GoogleDriveFolderRole = "root" | "motion" | "backups";

export interface GoogleDriveAbout {
  user: {
    permissionId: string | null;
    emailAddress: string | null;
    displayName: string | null;
  } | null;
  storageQuota: {
    limit: string | null;
    usage: string | null;
    usageInDrive: string | null;
    usageInDriveTrash: string | null;
  } | null;
}

export interface GoogleDriveFolder {
  id: string;
  name: string | null;
  mimeType: string | null;
  parents: readonly string[] | null;
  appProperties: Readonly<Record<string, string>> | null;
  driveId: string | null;
  ownedByMe: boolean | null;
  owners: readonly { permissionId: string | null }[] | null;
  permissionIds: readonly string[] | null;
  shared: boolean | null;
  trashed: boolean | null;
}

export interface GoogleDriveFolderPage {
  files: readonly GoogleDriveFolder[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}

export interface GoogleDriveFolderList {
  installationId: string;
  generationId: string;
  role: GoogleDriveFolderRole;
  parentId: string;
  pageToken: string | null;
  signal: AbortSignal;
}

export interface GoogleDriveFolderCreate {
  id: string;
  name: string;
  role: GoogleDriveFolderRole;
  parentId: string;
  appProperties: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

/** Narrow Google SDK boundary; application code never sees SDK resource types. */
export class GoogleDriveGateway {
  constructor(private readonly drive: drive_v3.Drive) {}

  async loadAbout(signal: AbortSignal): Promise<GoogleDriveAbout> {
    const response = await this.drive.about.get(
      { fields: "user(permissionId,emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)" },
      { signal },
    );
    const user = response.data.user;
    const quota = response.data.storageQuota;
    return {
      user: user === undefined || user === null ? null : {
        permissionId: nullableText(user.permissionId),
        emailAddress: nullableText(user.emailAddress),
        displayName: nullableText(user.displayName),
      },
      storageQuota: quota === undefined || quota === null ? null : {
        limit: nullableText(quota.limit),
        usage: nullableText(quota.usage),
        usageInDrive: nullableText(quota.usageInDrive),
        usageInDriveTrash: nullableText(quota.usageInDriveTrash),
      },
    };
  }

  async loadFolder(id: string, signal: AbortSignal): Promise<GoogleDriveFolder | null> {
    try {
      const response = await this.drive.files.get({ fileId: id, fields: FOLDER_FIELDS }, { signal });
      return toFolder(response.data);
    } catch (error) {
      if (providerStatus(error) === 404) return null;
      throw error;
    }
  }

  async listFolders(input: GoogleDriveFolderList): Promise<GoogleDriveFolderPage> {
    const response = await this.drive.files.list({
      corpora: "user",
      spaces: "drive",
      pageToken: input.pageToken ?? undefined,
      q: folderQuery(input),
      fields: `nextPageToken,incompleteSearch,files(${FOLDER_FIELDS})`,
    }, { signal: input.signal });
    return {
      files: (response.data.files ?? []).map(toFolder),
      nextPageToken: nullableText(response.data.nextPageToken),
      incompleteSearch: response.data.incompleteSearch === true,
    };
  }

  async generateFolderId(signal: AbortSignal): Promise<string> {
    const response = await this.drive.files.generateIds({ count: 1, space: "drive", fields: "ids" }, { signal });
    const ids = response.data.ids;
    if (!Array.isArray(ids) || ids.length !== 1 || !isText(ids[0])) {
      throw new DriveFolderAmbiguousError("Google Drive did not reserve exactly one folder ID");
    }
    return ids[0];
  }

  async createFolder(input: GoogleDriveFolderCreate): Promise<GoogleDriveFolder> {
    const response = await this.drive.files.create({
      ignoreDefaultVisibility: true,
      fields: FOLDER_FIELDS,
      requestBody: {
        id: input.id,
        name: input.name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [input.parentId],
        appProperties: { ...input.appProperties },
      },
    }, { signal: input.signal });
    return toFolder(response.data);
  }
}

function folderQuery(input: GoogleDriveFolderList): string {
  const properties = {
    a1v: "1",
    a1i: input.installationId,
    a1g: input.generationId,
    a1k: input.role,
  };
  const matches = Object.entries(properties).map(
    ([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`,
  );
  return [
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `'${escapeQuery(input.parentId)}' in parents`,
    ...matches,
  ].join(" and ");
}

function toFolder(file: drive_v3.Schema$File): GoogleDriveFolder {
  return {
    id: textOrEmpty(file.id),
    name: nullableText(file.name),
    mimeType: nullableText(file.mimeType),
    parents: file.parents === undefined || file.parents === null ? null : file.parents.filter(isText),
    appProperties: file.appProperties === undefined || file.appProperties === null ? null : copyProperties(file.appProperties),
    driveId: nullableText(file.driveId),
    ownedByMe: typeof file.ownedByMe === "boolean" ? file.ownedByMe : null,
    owners: file.owners === undefined || file.owners === null ? null : file.owners.map((owner) => ({ permissionId: nullableText(owner.permissionId) })),
    permissionIds: file.permissionIds === undefined || file.permissionIds === null ? null : file.permissionIds.filter(isText),
    shared: typeof file.shared === "boolean" ? file.shared : null,
    trashed: typeof file.trashed === "boolean" ? file.trashed : null,
  };
}

function copyProperties(properties: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(properties).filter(([, value]) => typeof value === "string")));
}

function nullableText(value: unknown): string | null {
  return isText(value) ? value : null;
}

function textOrEmpty(value: unknown): string {
  return isText(value) ? value : "";
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function providerStatus(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
