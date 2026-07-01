const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {google} = require('googleapis');

/**
 * OAuth scope used by this service so it can upload files and manage sharing permissions in Google Drive.
 */
const SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Local path to the service account key file used by this service.
 *
 * Override this by setting GOOGLE_APPLICATION_CREDENTIALS to an absolute path.
 */
const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'service-account.json');

/**
 * Escapes a value so it can be safely embedded inside a Google Drive query string.
 */
function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Normalizes a Drive path into a clean array of path segments.
 *
 * Backslashes are treated as separators, surrounding whitespace is trimmed,
 * and empty path parts are removed.
 */
function normalizeDrivePath(drivePath) {
  if (typeof drivePath !== 'string') {
    throw new TypeError('Drive path must be a string.');
  }

  return drivePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Authenticates with Google using a service account key and returns an initialized Drive API client.
 */
async function createDriveClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Service account key not found at ${CREDENTIALS_PATH}. Set GOOGLE_APPLICATION_CREDENTIALS or place a service-account.json file in the services folder.`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: SCOPES,
  });

  return google.drive({version: 'v3', auth});
}

/**
 * Lists Drive items that match a parent folder, name, and optional MIME type.
 */
async function listMatchingDriveItems(drive, {parentId, name, mimeType}) {
  const queryParts = [
    `'${parentId}' in parents`,
    `name = '${escapeDriveQueryValue(name)}'`,
    'trashed = false',
  ];

  if (mimeType) {
    queryParts.push(`mimeType = '${escapeDriveQueryValue(mimeType)}'`);
  }

  const response = await drive.files.list({
    q: queryParts.join(' and '),
    pageSize: 10,
    fields: 'files(id, name, mimeType, parents, webViewLink, webContentLink)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return response.data.files || [];
}

/**
 * Resolves a slash-delimited Drive folder path to a folder ID.
 *
 * When createMissing is true, any missing folder segment is created.
 */
async function resolveDriveFolderPath(drive, driveFolderPath, {createMissing = false} = {}) {
  const segments = normalizeDrivePath(driveFolderPath);

  if (segments.length === 0) {
    return 'root';
  }

  let parentId = 'root';

  for (const segment of segments) {
    const matches = await listMatchingDriveItems(drive, {
      parentId,
      name: segment,
      mimeType: 'application/vnd.google-apps.folder',
    });

    if (matches.length > 1) {
      throw new Error(`Ambiguous Drive folder path segment "${segment}" under parent ${parentId}.`);
    }

    if (matches.length === 0) {
      if (!createMissing) {
        throw new Error(`Drive folder not found: ${segments.join('/')}`);
      }

      const createdFolder = await drive.files.create({
        requestBody: {
          name: segment,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId === 'root' ? undefined : [parentId],
        },
        fields: 'id, name',
        supportsAllDrives: true,
      });

      parentId = createdFolder.data.id;
      continue;
    }

    parentId = matches[0].id;
  }

  return parentId;
}

/**
 * Resolves a slash-delimited Drive file path to a unique file item.
 */
async function resolveDriveFileByPath(drive, driveFilePath) {
  const segments = normalizeDrivePath(driveFilePath);

  if (segments.length === 0) {
    throw new Error('Drive file path is required.');
  }

  const fileName = segments[segments.length - 1];
  const folderPath = segments.slice(0, -1).join('/');
  const folderId = await resolveDriveFolderPath(drive, folderPath);
  const matches = await listMatchingDriveItems(drive, {
    parentId: folderId,
    name: fileName,
  });

  if (matches.length > 1) {
    throw new Error(`Ambiguous Drive file path: ${driveFilePath}`);
  }

  if (matches.length === 0) {
    throw new Error(`Drive file not found: ${driveFilePath}`);
  }

  return matches[0];
}

/**
 * Uploads a local file into Drive and returns the created file metadata.
 */
async function uploadFile(localFilePath, driveFolderPath = '', options = {}, driveClient = null) {
  if (!localFilePath) {
    throw new Error('Local file path is required.');
  }

  await fsp.access(localFilePath, fs.constants.R_OK);

  const drive = driveClient || await createDriveClient();
  const folderId = await resolveDriveFolderPath(drive, driveFolderPath, {createMissing: true});
  const fileName = options.fileName || path.basename(localFilePath);
  const mimeType = options.mimeType || 'application/octet-stream';

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType,
      parents: folderId === 'root' ? undefined : [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(localFilePath),
    },
    fields: 'id, name, mimeType, parents, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  return response.data;
}

/**
 * Resolves a Drive file path, ensures it is shared with anyone who has the link,
 * and returns the best available share URL.
 */
async function getShareLink(driveFilePath, driveClient = null) {
  const drive = driveClient || await createDriveClient();
  const file = await resolveDriveFileByPath(drive, driveFilePath);

  const existingPermissions = await drive.permissions.list({
    fileId: file.id,
    fields: 'permissions(id, type, role)',
    supportsAllDrives: true,
  });

  const hasAnyoneReader = (existingPermissions.data.permissions || []).some((permission) => {
    return permission.type === 'anyone' && permission.role === 'reader';
  });

  if (!hasAnyoneReader) {
    await drive.permissions.create({
      fileId: file.id,
      requestBody: {
        type: 'anyone',
        role: 'reader',
      },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
  }

  const refreshed = await drive.files.get({
    fileId: file.id,
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  return refreshed.data.webViewLink || refreshed.data.webContentLink || `https://drive.google.com/file/d/${file.id}/view?usp=sharing`;
}

/**
 * Public API exposed by this module for callers that need Drive upload or sharing helpers.
 */
module.exports = {
  // public API
  createDriveClient,
  getShareLink,
  resolveDriveFileByPath,
  resolveDriveFolderPath,
  uploadFile,
  // helpers (exported for testing)
  escapeDriveQueryValue,
  normalizeDrivePath,
  listMatchingDriveItems,
};

if (require.main === module) {
  console.log('Google Drive service loaded. Import uploadFile or getShareLink from this module.');
}