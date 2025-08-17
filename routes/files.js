import express from 'express';
import multer from 'multer';
import { supabase } from '../supabaseClient.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import crypto from 'crypto';


const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const folder_id = req.body.folder_id || null;

    // Always get user ID from authenticated token, do NOT accept from client
    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ error: 'Invalid or missing user ID in token' });
    }

    // Generate a secure, unique storage path
    const storageKey = `uploads/${user.id}/${Date.now()}_${file.originalname}`;

    // Upload file buffer to Supabase Storage bucket
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('filehaven-files')
      .upload(storageKey, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) throw uploadError;

    // Generate checksum (MD5 hash) for integrity check (optional but good practice)
    const checksum = crypto.createHash('md5').update(file.buffer).digest('hex');

    // Insert metadata into 'files' table
    // IMPORTANT: user_id is set only from authenticated user; no client input allowed here
    const { error: dbError } = await supabase
      .from('files')
      .insert(
        [
          {
            name: file.originalname,
            mime_type: file.mimetype,
            size_bytes: file.size,
            storage_key: storageKey,
            owner_id: user.id,
            folder_id: folder_id,
            version_id: null,
            checksum,
            is_deleted: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        { returning: 'minimal' } // Avoid select which needs extra RLS permissions
      );

  if (dbError) throw dbError;


    return res.json({ success: true, message: 'File uploaded successfully.' });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


router.post('/folders', authMiddleware, async (req, res) => {
  const user = req.user;
  const { name, parent_id } = req.body;

  const { error } = await supabase
    .from('folders')
    .insert([{
      name,
      owner_id: user.id,
      parent_id: parent_id || null,
    }]);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Folder created.' });
});


router.patch('/folders/:id/rename', authMiddleware, async (req, res) => {
  const user = req.user;
  const { id } = req.params;
  const { newName } = req.body;

  // Ownership check
  const { data: folder } = await supabase
    .from('folders')
    .select('owner_id')
    .eq('id', id)
    .single();

  if (!folder || folder.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  await supabase
    .from('folders')
    .update({ name: newName, updated_at: new Date().toISOString() })
    .eq('id', id);

  res.json({ success: true, message: 'Folder renamed.' });
});


router.delete('/files/:id', authMiddleware, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const { data: file } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id)
    .single();

  if (!file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  await supabase
    .from('files')
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq('id', id);

  res.json({ success: true, message: 'File moved to trash.' });
});


router.get('/folder-contents', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const folderId = req.query.folderId; // note: don't coalesce to null here
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const offset = (page - 1) * pageSize;

    // Folders query
    let foldersQuery = supabase
      .from('folders')
      .select('*')
      .eq('owner_id', user.id)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (folderId) {
      foldersQuery = foldersQuery.eq('parent_id', folderId);
    } else {
      foldersQuery = foldersQuery.is('parent_id', null); // Root folder
    }

    const { data: folders, error: foldersError } = await foldersQuery;
    if (foldersError) throw foldersError;

    // Files query
    let filesQuery = supabase
      .from('files')
      .select('*')
      .eq('owner_id', user.id)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (folderId) {
      filesQuery = filesQuery.eq('folder_id', folderId);
    } else {
      filesQuery = filesQuery.is('folder_id', null); // Root folder
    }

    const { data: files, error: filesError } = await filesQuery;
    if (filesError) throw filesError;

    res.json({ folders, files });
  } catch (err) {
    console.error('Listing folder contents error:', err);
    res.status(500).json({ error: 'Failed to fetch folder contents' });
  }
});








/**
 * GET /folder-contents
 * Query param: folderId (optional) - null or a UUID of the folder to list inside
 * Responds with JSON containing arrays: folders and files inside that folder, excluding deleted ones
 */
/*
router.get('/folder-contents', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const folderId = req.query.folderId; 
     const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const offset = (page - 1) * pageSize;

    // Fetch folders owned by user that are not deleted inside the requested folder
    const { data: folders, error: foldersError } = await supabase
      .from('folders')
      .select('*')
      .eq('owner_id', user.id)
      .eq('parent_id', folderId)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .range(offset, offset + pageSize - 1);


    if (foldersError) {
      throw foldersError;
    }

    // Fetch files owned by user that are not deleted inside the requested folder
    const { data: files, error: filesError } = await supabase
      .from('files')
      .select('*')
      .eq('owner_id', user.id)
      .eq('folder_id', folderId)
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (filesError) {
      throw filesError;
    }

    // Respond with both folders and files so frontend can display hierarchy
    res.json({ folders, files });

  } catch (err) {
    console.error('Listing folder contents error:', err);
    res.status(500).json({ error: 'Failed to fetch folder contents' });
  }
});*/


/**
 * Recursively soft delete a folder and its contents (subfolders and files)
 * @param {string} folderId - ID of the folder to delete
 */
async function cascadeSoftDeleteFolder(folderId) {
  // Soft delete the target folder
  await supabase
    .from('folders')
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq('id', folderId);

  // Soft delete all files inside this folder
  await supabase
    .from('files')
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq('folder_id', folderId);

  // Find all subfolders of this folder
  const { data: subfolders, error } = await supabase
    .from('folders')
    .select('id')
    .eq('parent_id', folderId)
    .eq('is_deleted', false); // only consider non-deleted folders

  if (error) {
    throw error;
  }

  // Recursively soft delete each subfolder
  if (subfolders && subfolders.length > 0) {
    for (const subfolder of subfolders) {
      await cascadeSoftDeleteFolder(subfolder.id);
    }
  }
}

// Route to soft delete a folder recursively
router.delete('/folders/:id', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const folderId = req.params.id;

    // Check folder ownership first
    const { data: folder, error: getFolderError } = await supabase
      .from('folders')
      .select('owner_id')
      .eq('id', folderId)
      .single();

    if (getFolderError || !folder) {
      return res.status(404).json({ error: 'Folder not found.' });
    }
    if (folder.owner_id !== user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this folder.' });
    }

    // Perform cascade soft delete
    await cascadeSoftDeleteFolder(folderId);

    res.json({ success: true, message: 'Folder and its contents moved to trash.' });
  } catch (err) {
    console.error('Cascade soft delete error:', err);
    res.status(500).json({ error: 'Failed to delete folder.' });
  }
});


// POST /api/files/:id/share-link
router.post('/files/:id/share-link', authMiddleware, async (req, res) => {
  console.log("share link handler hit");
  const { id } = req.params;
  const { expiresAt, permissionType } = req.body || {};
  const user = req.user;

  // 1. Only owner may create link
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id).single();
  if (fileErr || !file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  // 2. Generate token, insert
  const token = crypto.randomBytes(24).toString('hex');
  const { error } = await supabase.from('share_links').insert([{
    file_id: id,
    link_token: token,
    expires_at: expiresAt || null,
    created_by: user.id,
    permission_type: permissionType || 'view'
  }]);
  if (error) return res.status(500).json({ error: error.message });

  const shareUrl = `${process.env.SHARE_BASE_URL || 'http://localhost:3000'}/s/${token}`;
  res.json({ url: shareUrl });
});



// POST /api/files/:id/permissions
router.post('/files/:id/permissions', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { sharedWith, permissionType } = req.body;
  const user = req.user;

  // Only owner may share/edit permission
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id).single();
  if (fileErr || !file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  // Upsert permission (avoid duplicates)
  const { data, error } = await supabase.from('permissions').upsert([{
    file_id: id,
    shared_with: sharedWith,
    permission_type: permissionType
  }], { onConflict: ['file_id', 'shared_with'] });

  console.log('Upsert data:', data);
  console.log('Upsert error:', error);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, message: 'Permission granted.' });
});


// GET /s/:token (No auth required for public share)

router.get('/s/:token', async (req, res) => {
  const { token } = req.params;

  // Find share_link, check expiry/active
  const { data: link, error: linkErr } = await supabase
    .from('share_links')
    .select('file_id, expires_at, is_active, permission_type')
    .eq('link_token', token)
    .single();

  if (linkErr || !link || !link.is_active || (link.expires_at && new Date() > new Date(link.expires_at))) {
    return res.status(404).json({ error: 'Link expired or not found.' });
  }

  // Find file and path
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('storage_key')
    .eq('id', link.file_id)
    .single();

  if (fileErr || !file) return res.status(404).json({ error: 'File not found.' });

  // Generate signed URL
  const { data, error: urlErr } = await supabase.storage
    .from('filehaven-files')
    .createSignedUrl(file.storage_key, 900);

  if (urlErr)
    return res.status(500).json({ error: 'Failed to generate signed URL.' });

  res.json({ url: data.signedUrl, permission: link.permission_type });
});







router.get('/files/:id/download', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Fetch file metadata to verify ownership
    const { data: fileData, error: fetchError } = await supabase
      .from('files')
      .select('storage_key, owner_id')
      .eq('id', id)
      .single();

    if (fetchError || !fileData) {
      return res.status(404).json({ error: 'File not found' });
    }

       // 1. File owner always allowed
    if (fileData.owner_id !== user.id) {
      console.log('User ID:', user.id);
console.log('File owner:', fileData.owner_id);
      // 2. ELSE: Check permissions table (shared access)
      const { data: perm, error: permError } = await supabase
        .from('permissions')
        .select('permission_type')
        .eq('file_id', id)
        .eq('shared_with', user.id)
        .maybeSingle();
        console.log('Permission:', perm);

      if (permError || !perm) {
        return res.status(403).json({ error: 'Unauthorized to access this file' });
      }
      // Optionally: only allow download for 'view' or higher role
      // if (perm.permission_type !== 'view' && perm.permission_type !== 'edit') {
      //   return res.status(403).json({ error: 'Insufficient permissions' });
      // }
    }

    // The user is either the owner or is listed in permissions table—allow download below!
    const { data, error: urlError } = await supabase.storage
      .from('filehaven-files')
      .createSignedUrl(fileData.storage_key, 900);

    if (urlError) throw urlError;

    res.json({ url: data.signedUrl });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to generate signed URL' });
  }
});



// DELETE /files/:id/share-link/:token
router.delete('/files/:id/share-link/:token', authMiddleware, async (req, res) => {
  const { id, token } = req.params;
  const user = req.user;

  // Only owner can revoke share link
  const { data: file } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id)
    .single();
  if (!file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  // Deactivate the link
  const { error } = await supabase
    .from('share_links')
    .update({ is_active: false })
    .eq('file_id', id)
    .eq('link_token', token);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Share link revoked.' });
});


// DELETE /files/:id/permissions/:sharedWith
router.delete('/files/:id/permissions/:sharedWith', authMiddleware, async (req, res) => {
  const { id, sharedWith } = req.params;
  const user = req.user;

  // Only owner can revoke user access
  const { data: file } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id)
    .single();
  if (!file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  // Delete the permission
  const { error } = await supabase
    .from('permissions')
    .delete()
    .eq('file_id', id)
    .eq('shared_with', sharedWith);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: 'Permission revoked.' });
});


/**
 * GET /search/files?query=term&page=1&pageSize=20
 */
router.get('/search/files', authMiddleware, async (req, res) => {
  const user = req.user;
  const { query, page = 1, pageSize = 20 } = req.query;
  if (!query) return res.status(400).json({ error: "Query is required" });

  // Pagination math
  const limit = parseInt(pageSize, 10);
  const offset = (parseInt(page, 10) - 1) * limit;

  // Raw Postgres query for full-text search with pagination
  const { data, error } = await supabase.rpc('files_search', {
    q: query,
    ownerid: user.id,
    lim: limit,
    offs: offset
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ results: data });
});


// GET /search/folders?query=term&page=1&pageSize=20
router.get('/search/folders', authMiddleware, async (req, res) => {
  const user = req.user;
  const { query, page = 1, pageSize = 20 } = req.query;
  if (!query) return res.status(400).json({ error: "Query is required" });

  const limit = parseInt(pageSize, 10);
  const offset = (parseInt(page, 10) - 1) * limit;

  const { data, error } = await supabase.rpc('folders_search', {
    q: query,
    ownerid: user.id,
    lim: limit,
    offs: offset
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ results: data });
});

// files.js
router.get('/storage', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { data: files, error } = await supabase
      .from('files')
      .select('size_bytes')
      .eq('owner_id', user.id)
      .eq('is_deleted', false);

    if (error) throw error;

    const used = files.reduce((acc, f) => acc + f.size_bytes, 0);
    const total = 1024 * 1024 * 500; // 500MB per user (example quota)

    res.json({ used, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate storage' });
  }
});


// Add to your files.js or a suitable router file

router.get('/shared-with-me', authMiddleware, async (req, res) => {
  const user = req.user;

  // Find all files where this user has a row in permissions table
  const { data: permissions, error: permissionsError } = await supabase
    .from('permissions')
    .select('file_id, shared_with, permission_type, created_at')
    .eq('shared_with', user.id);

  if (permissionsError) {
    return res.status(500).json({ error: permissionsError.message });
  }

  const fileIds = permissions.map(p => p.file_id);
  if (!fileIds.length) return res.json([]);

  // Fetch corresponding files and their owners
  const { data: files, error: filesError } = await supabase
    .from('files')
    .select('id, name, owner_id, created_at')
    .in('id', fileIds)
    .eq('is_deleted', false);

  if (filesError) {
    return res.status(500).json({ error: filesError.message });
  }

  // Optionally, fetch owner info (assuming you have a 'users' table)
  // You can join or fetch separately based on your schema.

  // Merge info to what frontend expects
  // To include shared_by, you'd need to resolve owner_id to email/name if needed.
  const results = files.map(f => ({
    name: f.name,
    shared_by: f.owner_id,
    shared_at: permissions.find(p => p.file_id === f.id)?.created_at
  }));

  return res.json(results);
});







router.get('/db-health', async (req, res) => {
  const t0 = Date.now();
  const { error } = await supabase.rpc('files_search', { q: 'test', ownerid: 'SOME_USER_ID', lim: 1, offs: 0 });
  const t1 = Date.now();
  if (error) return res.status(500).json({ error: error.message, ms: t1 - t0 });
  res.json({ ms: t1 - t0, status: 'healthy' });
});





export default router;









/*import express from 'express';
import multer from 'multer';
import { supabase } from '../supabaseClient.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import crypto from 'crypto';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const user = req.user; // { id, email }

    // Create unique storage key/path inside the bucket
    const storageKey = `uploads/${user.id}/${Date.now()}_${file.originalname}`;

    // Upload file buffer to Supabase Storage bucket
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('filehaven-files')
      .upload(storageKey, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) throw uploadError;

    // Optional: generate checksum (MD5)
    const checksum = crypto.createHash('md5').update(file.buffer).digest('hex');

    // Insert into "files" table
    const { error: dbError } = await supabase
      .from('files')
      .insert([
        {
          // id is auto-generated (UUID PK)
          name: file.originalname,                      // text
          mime_type: file.mimetype,                     // text
          size_bytes: file.size,                        // bigint
          storage_key: storageKey,                      // path in bucket
          user_id: user.id,                            // uuid → users.id
          folder_id: null,                              // nullable; set later if needed
          version_id: null,                             // nullable pointer
          checksum: checksum,                           // md5 hash string
          is_deleted: false,                            // default
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ] , {returning :'minimal ' });

    if (dbError) throw dbError;

    return res.json({ success: true, file: dbData[0] });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
*/