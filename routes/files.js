import express from 'express';
import multer from 'multer';
import { supabase } from '../supabaseClient.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import crypto from 'crypto';
import { findOrCreateFolder } from '../services/folderService.js'; 
import { v4 as uuidv4 } from 'uuid';
import { version } from 'os';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();




router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const user = req.user;
    if (!user?.id) {
      return res.status(401).json({ error: 'Invalid or missing user ID in token' });
    }

    // Extract and sanitize folder_id from req.body
    let folder_id = req.body.folder_id;
    console.log("Initial folder_id from req.body:", folder_id);
    if (folder_id === undefined || folder_id === "null" || folder_id === "root" || folder_id === "") {
      folder_id = null;
    } else if (typeof folder_id === "string") {
      folder_id = folder_id.trim();
    }
    console.log("Sanitized folder_id:", folder_id);

    let finalFolderId = (folder_id === null || folder_id === "null" || folder_id === "root") ? null : folder_id;
    console.log("finalFolderId before relativePath:", finalFolderId);

    // Handle relativePath folder creation separately with error handling
    let tempFolderId = folder_id;
    if (req.body.relativePath) {
      try {
        const parts = req.body.relativePath.split('/').filter(Boolean);
        parts.pop(); // Remove file name
        for (const folderName of parts) {
          console.log(`Processing folder: ${folderName}, parentId: ${tempFolderId}`);
          const newFolderId = await findOrCreateFolder(user.id, folderName, tempFolderId);
          console.log(`Folder ${folderName} created with id: ${newFolderId}`);
          if (!newFolderId) {
            throw new Error(`Failed to create or find folder: ${folderName}`);
          }
          tempFolderId = newFolderId; // Update tempFolderId
        }
        if (tempFolderId) finalFolderId = tempFolderId; // Update only if a new folder is created
      } catch (loopErr) {
        console.error("RelativePath loop error:", loopErr.message);
        throw loopErr;
      }
    }
    console.log("finalFolderId after relativePath:", finalFolderId);
    console.log("tempFolderId after loop:", tempFolderId);

    const storageKey = `uploads/${user.id}/${Date.now()}_${uuidv4()}_${file.originalname}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('filehaven-files')
      .upload(storageKey, file.buffer, {
        contentType: file.mimetype,
      });
    if (uploadError) throw uploadError;

    const checksum = crypto.createHash('md5').update(file.buffer).digest('hex');

    // Final validation and logging before insert
    console.log("Payload folder_id before insert:", finalFolderId);
    if (finalFolderId !== null && typeof finalFolderId !== 'string') {
      throw new Error("Invalid folder_id format");
    }
    if (finalFolderId === "null") {
      finalFolderId = null; // Force correction if somehow stringified
    }

    const payload = {
      id: uuidv4(),
      name: file.originalname,
      mime_type: file.mimetype,
      size_bytes: file.size,
      storage_key: storageKey,
      owner_id: user.id,
      folder_id: finalFolderId,
      checksum,
      is_deleted: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: insertErr } = await supabase
      .from('files')
      .insert([payload], { returning: 'minimal' });

    if (insertErr) {
      console.error("File insert error:", insertErr.message);
      throw insertErr;
    }

    await supabase.from("notifications").insert({
      user_id: user.id,
      type: "file_uploaded",
      title: "File uploaded successfully",
      message: `${file.originalname} was uploaded to your drive`,
      icon: "upload",
      timestamp: new Date().toISOString(),
      read: false,
    });

    return res.json({ success: true, message: 'File uploaded successfully.' });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});




router.get('/files/:id/versions', authMiddleware, async (req, res) => {
  const fileId = req.params.id;
  const user = req.user;

  // Confirm ownership
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', fileId)
    .single();

  if (fileErr || !file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Get versions ordered desc by version_number
  const { data, error } = await supabase
    .from('file_versions')
    .select('*')
    .eq('file_id', fileId)
    .order('version_number', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, versions: data });
});

router.post('/files/:id/versions/:versionId/restore', authMiddleware, async (req, res) => {
  const fileId = req.params.id;
  const versionId = req.params.versionId;
  const user = req.user;

  // Confirm ownership
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', fileId)
    .single();

  if (fileErr || !file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Get version info
  const { data: version, error: versionErr } = await supabase
    .from('file_versions')
    .select('storage_key')
    .eq('id', versionId)
    .eq('file_id', fileId)
    .single();

  if (versionErr || !version) {
    return res.status(404).json({ error: 'Version not found' });
  }

  // Update main file with version's storage_key and timestamp
  const { error: updateError } = await supabase
    .from('files')
    .update({
      storage_key: version.storage_key,
      updated_at: new Date().toISOString(),
    })
    .eq('id', fileId);

  if (updateError) return res.status(500).json({ error: updateError.message });

  res.json({ success: true, message: 'File version restored' });
});



router.post('/folders', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    let { name, parent_id } = req.body;

    // Validate input
    console.log("Request body:", req.body);
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    // Fix: treat "null" or "root" string as actual null
    if (!parent_id || parent_id === "null" || parent_id === "root") {
      parent_id = null;
    }

    else if (parent_id && typeof parent_id === 'string') {
      const { data: parentExists, error: parentError } = await supabase
        .from('folders')
        .select('id')
        .eq('id', parent_id)
        .eq('is_deleted', false)
        .single();
      if (parentError || !parentExists) {
        return res.status(400).json({ error: 'Invalid parent folder ID' });
      }
    }
  



    // Create folder
    const { data: newFolder, error: folderError } = await supabase
      .from('folders')
      .insert([{
        name,
        owner_id: user.id,
        parent_id: parent_id ,
      }])
      .select()   // <-- returns the inserted folder(s)

    if (folderError) {
      console.error("Folder insert error:", folderError.message);
      return res.status(500).json({ error: folderError.message });
    }

    // Create notification
    const { error: notifError } = await supabase.from("notifications").insert({
      user_id: user.id,
      type: "folder_created",
      title: "Folder created",
      message: `Folder "${name}" was created`,
      icon: "folder",
      timestamp: new Date().toISOString(),
      read: false,
    });

    if (notifError) {
      console.error("Notification insert error:", notifError.message);
      // don’t block folder creation – just log it
    }

    // Send proper response
    res.status(201).json({ message: "Folder created", folder: newFolder[0] });

  } catch (err) {
    console.error("Folder creation error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
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

    await supabase.from("notifications").insert({
  user_id: user.id,
  type: "folder_renamed",
  title: "Folder renamed",
  message: `Folder was renamed to "${newName}"`,
  icon: "folder",
  timestamp: new Date().toISOString(),
  read: false,
});

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

router.delete('/trash/file/:id/permanent', authMiddleware, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const { data: file } = await supabase.from('files').select('owner_id').eq('id', id).single();
  if (!file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed to delete this file.' });
  }

  // Optionally, delete from storage bucket also (implement as needed)

  await supabase.from('files').delete().eq('id', id);
  res.json({ success: true, message: 'File permanently deleted.' });
});


async function cascadePermanentDeleteFolder(folderId) {
  // Delete files inside folder
  await supabase.from('files').delete().eq('folder_id', folderId);

  // Get subfolders
  const { data: subfolders } = await supabase.from('folders').select('id').eq('parent_id', folderId);

  // Recursively delete subfolders
  if (subfolders?.length) {
    for (const subfolder of subfolders) {
      await cascadePermanentDeleteFolder(subfolder.id);
    }
  }

  // Delete this folder
  await supabase.from('folders').delete().eq('id', folderId);
}



router.delete('/trash/folder/:id/permanent', authMiddleware, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const { data: folder } = await supabase.from('folders').select('owner_id').eq('id', id).single();
  if (!folder || folder.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed to delete this folder.' });
  }

  // Optionally, cascade hard delete for all contents here

  await cascadePermanentDeleteFolder(id);
  res.json({ success: true, message: 'Folder permanently deleted.' });
});


async function addFileVersion(fileId, storageKey) {
  // Get latest version number
  const { data: latestVersion } = await supabase
    .from('file_versions')
    .select('version_number')
    .eq('file_id', fileId)
    .order('version_number', { ascending: false })
    .limit(1)
    .single();

  const nextVersionNum = latestVersion ? latestVersion.version_number + 1 : 1;

  await supabase.from('file_versions').insert([{
    file_id: fileId,
    storage_key: storageKey,
    version_number: nextVersionNum,
    created_at: new Date().toISOString()
  }]);
}






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

  const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';

const shareUrl = `${FRONTEND_BASE_URL}/s/${token}`;


  // 3️⃣ Insert notification
    await supabase.from("notifications").insert({
      
      type: "file_shared",
      title: "File shared ",
      message: `${file.originalname} was shared `,
      icon: "share",
      timestamp: new Date().toISOString(),
      read: false,
    });
  res.json({ url: shareUrl });
});



// POST /api/files/:id/permissions
router.post('/files/:id/permissions', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { sharedWith, permissionType } = req.body;
  const user = req.user;

  // Log request details
  console.log('Permission request - fileId:', id, 'sharedWith:', sharedWith, 'permissionType:', permissionType, 'Timestamp:', new Date().toISOString());

  // Validate inputs
  if (!id || id === "undefined") {
    return res.status(400).json({ error: 'Invalid file ID' });
  }
  if (!sharedWith || typeof sharedWith !== 'string') {
    return res.status(400).json({ error: 'Email is required' });
  }
  if (!permissionType || !['view', 'edit'].includes(permissionType)) {
    return res.status(400).json({ error: 'Invalid permission type' });
  }

  // Only owner may share/edit permission
  const { data: file, error: fileErr } = await supabase
    .from('files')
    .select('owner_id')
    .eq('id', id)
    .single();
  if (fileErr || !file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Look up user UUID for sharedWith email
  const { data: userToShare, error: userErr } = await supabase
    .from('users')
    .select('id')
    .eq('email', sharedWith.trim().toLowerCase())
    .single();

  if (userErr && userErr.code !== 'PGRST116') {
    console.error('User lookup error:', userErr.message);
    return res.status(500).json({ error: 'Error looking up user' });
  }

  let targetUserId;
  if (!userToShare) {
    return res.status(404).json({ error: 'User not found' }); // Reject if user doesn't exist
  } else {
    targetUserId = userToShare.id;
  }

  // Upsert permission with explicit select to return the row
  const { data, error, count } = await supabase
    .from('permissions')
    .upsert(
      [{ file_id: id, shared_with: targetUserId, permission_type: permissionType }],
      { onConflict: ['file_id', 'shared_with'], returning: 'representation' } // Ensure row is returned
    )
    .select('*'); // Explicitly select all columns

  if (error) {
    console.error('Upsert error:', error.message, 'Data:', data);
    return res.status(500).json({ error: error.message });
  }

  if (!data || data.length === 0) {
    console.log('No rows affected by upsert - possible conflict with no changes');
    return res.status(200).json({ success: true, message: 'Permission already exists.' });
  }

  console.log('Upsert success - data:', data);
  res.json({ success: true, message: 'Permission granted.', permissions: data });
});


// GET /s/:token (No auth required for public share)
/*

router.get("/s/:token", async (req, res) => {
  const { token } = req.params;

  // 1. Get link info
  const { data: link, error: linkErr } = await supabase
    .from("share_links")
    .select("file_id, expires_at, is_active, permission_type")
    .eq("link_token", token)
    .single();

  if (linkErr || !link || !link.is_active || (link.expires_at && new Date() > new Date(link.expires_at))) {
    return res.status(404).json({ error: "Link expired or not found." });
  }

console.log("🔍 Looking for file_id:", link.file_id);

  // 2. Get file details
  const { data: file, error: fileErr } = await supabase
    .from("files")
    .select("id, name, size_bytes, created_at, storage_key")
    .eq("id", link.file_id)
    .single();


    console.log("🔍 File query result:", file, fileErr);

  if (fileErr || !file) {
    return res.status(404).json({ error: "File not found." });
  }

  // 3. Get signed URL
  const { data: signed, error: signedErr } = await supabase.storage
    .from("filehaven-files")
    .createSignedUrl(file.storage_key, 60 * 60); // valid 1 hr

  if (signedErr) {
    console.error("Signed URL error:", signedErr);
    return res.status(500).json({ error: "Could not generate signed URL." });
  }

  // 4. Return response
  return res.json({
    file: {
      name: file.name,
      size: file.size_bytes,
      created_at: file.created_at,
    },
    permission: link.permission_type,
    expires_at: link.expires_at,
    url: signed.signedUrl,
  });
});
*/



router.get("/s/:token", async (req, res) => {
  const { token } = req.params;

  // 1. Get link info
  const { data: link, error: linkErr } = await supabase
    .from("share_links")
    .select("file_id, expires_at, is_active, permission_type")
    .eq("link_token", token)
    .single();

  if (linkErr || !link || !link.is_active || (link.expires_at && new Date() > new Date(link.expires_at))) {
    return res.status(404).json({ error: "Link expired or not found." });
  }

console.log("🔍 Looking for file_id:", link.file_id);

  // 2. Get file details
  const { data: file, error: fileErr } = await supabase
    .from("files")
    .select("id, name, size_bytes, created_at, storage_key")
    .eq("id", link.file_id)
    .single();


    console.log("🔍 File query result:", file, fileErr);

  if (fileErr || !file) {
    return res.status(404).json({ error: "File not found." });
  }

  // 3. Get signed URL
  const { data: signed, error: signedErr } = await supabase.storage
    .from("files")
    .createSignedUrl(file.storage_key, 60 * 60); // valid 1 hr

  if (signedErr) {
    console.error("Signed URL error:", signedErr);
    return res.status(500).json({ error: "Could not generate signed URL." });
  }

  // 4. Return response
  return res.json({
    file: {
      name: file.name,
      size: file.size_bytes,
      created_at: file.created_at,
    },
    permission: link.permission_type,
    expires_at: link.expires_at,
    url: signed.signedUrl,
  });
});

// GET /api/files/:id/permissions-list
router.get('/files/:id/permissions-list', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const user = req.user;
  // Only owner can see full list
  const { data: file, error } = await supabase.from('files').select('owner_id').eq('id', id).single();
  if (error || !file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  const { data: perms, error: permErr } = await supabase
    .from('permissions')
    .select('shared_with, permission_type,users!permissions_shared_with_fkey(id, email)')
    .eq('file_id', id);
  if (permErr)
    return res.status(500).json({ error: permErr.message });
  res.json({ success: true, permissions: perms.map(p => ({ id: p.users?.id,
      email: p.users?.email,
      permissionType: p.permission_type })) });
});


// GET /api/files/:id/share-links
router.get('/files/:id/share-links', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const user = req.user;
  const SHARE_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
  // Only owner can list
  const { data: file, error } = await supabase.from('files').select('owner_id').eq('id', id).single();
  if (error || !file || file.owner_id !== user.id)
    return res.status(403).json({ error: 'Not allowed' });

  const { data: links, error: linkErr } = await supabase
    .from('share_links')
    .select('link_token, permission_type, is_active')
    .eq('file_id', id)
    .eq('is_active', true);

  if (linkErr) return res.status(500).json({ error: linkErr.message });

  res.json({
    success: true,
    links: links.map(l => ({
      url: `${SHARE_BASE_URL}/s/${l.link_token}`,
      token: l.link_token,
      permission_type: l.permission_type
    }))
  });
});




/*
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
});*/


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
      .from('files')
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
  try {
    const user = req.user;
    const {
      query = '',
      page = '1',
      pageSize = '20',
      fileType = '',         // "document" | "image" | "video" | "audio" | "archive"
      owner = '',            // "" | "me" | "shared"
      location = '',         // "" | "mydrive" | "shared" | "recent" | ""
      inTrash = 'false',
      starred = 'false',
      encrypted = 'false',
      sortBy = 'name',       // "name" | "size_bytes" | "created_at"
      sortOrder = 'asc',     // "asc" | "desc"
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limit;
    const ascending = (sortOrder || 'asc').toLowerCase() !== 'desc';

    // Resolve list base (owned vs shared)
    let fileIdsFilter = null;
    if (owner === 'shared' || location === 'shared') {
      const { data: perms, error: permsError } = await supabase
        .from('permissions')
        .select('file_id')
        .eq('shared_with', user.id);

      if (permsError) throw permsError;
      const ids = (perms || []).map(p => p.file_id);
      fileIdsFilter = ids.length ? ids : ['00000000-0000-0000-0000-000000000000']; // empty guard
    }

    let q = supabase
      .from('files')
      .select('id, name, size_bytes, mime_type, created_at, updated_at, owner_id, folder_id, is_deleted, is_starred', { count: 'exact' });

    // Scope: owned or shared
    if (fileIdsFilter) {
      q = q.in('id', fileIdsFilter);
    } else {
      q = q.eq('owner_id', user.id);
    }

    // Location / trash
    const inTrashBool = String(inTrash) === 'true' || location === 'trash';
    if (inTrashBool) q = q.eq('is_deleted', true);
    else q = q.eq('is_deleted', false);

    // Starred
    if (String(starred) === 'true') q = q.eq('is_starred', true);

    // Encrypted (if column exists in your schema; if not, remove this filter)
    if (String(encrypted) === 'true') q = q.eq('is_encrypted', true);

    // File type -> mime filters
    if (fileType) {
      const t = fileType.toLowerCase();
      if (t === 'image') q = q.ilike('mime_type', 'image/%');
      else if (t === 'video') q = q.ilike('mime_type', 'video/%');
      else if (t === 'audio') q = q.ilike('mime_type', 'audio/%');
      else if (t === 'archive') q = q.or('mime_type.ilike.%zip%,mime_type.ilike.%rar%,mime_type.ilike.%7z%,mime_type.ilike.%tar%');
      else if (t === 'document') {
        q = q.or([
          "mime_type.ilike.%pdf%",
          "mime_type.ilike.%msword%",
          "mime_type.ilike.%officedocument%",
          "mime_type.ilike.%text%"
        ].join(','));
      }
    }

    // Basic name search
    if (query && query.trim().length) {
      const term = `%${query.trim()}%`;
      q = q.ilike('name', term);
    }

    // Sorting
    const sortField = ['name', 'size_bytes', 'created_at'].includes(sortBy) ? sortBy : 'name';
    q = q.order(sortField, { ascending });

    // Pagination
    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({
      results: data || [],
      page: pageNum,
      pageSize: limit,
      total: count ?? 0,
      hasMore: count ? offset + (data?.length || 0) < count : false
    });
  } catch (err) {
    console.error('Search files error:', err);
    res.status(500).json({ error: 'Search files failed' });
  }
});

// ---------- SEARCH: FOLDERS ----------
router.get('/search/folders', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const {
      query = '',
      page = '1',
      pageSize = '20',
      owner = '',
      location = '',
      inTrash = 'false',
      sortBy = 'name',     // "name" | "created_at"
      sortOrder = 'asc',
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limit;
    const ascending = (sortOrder || 'asc').toLowerCase() !== 'desc';

    // "Shared" folders typically require a share model; if you don't share folders,
    // keep it to owned folders only, or implement a similar permission model.
    let q = supabase
      .from('folders')
      .select('id, name, parent_id, owner_id, created_at, updated_at, is_deleted', { count: 'exact' });

    // Scope: owned only (common case)
    q = q.eq('owner_id', user.id);

    // Trash
    const inTrashBool = String(inTrash) === 'true' || location === 'trash';
    if (inTrashBool) q = q.eq('is_deleted', true);
    else q = q.eq('is_deleted', false);

    // Name search
    if (query && query.trim().length) {
      const term = `%${query.trim()}%`;
      q = q.ilike('name', term);
    }

    // Sorting
    const sortField = ['name', 'created_at'].includes(sortBy) ? sortBy : 'name';
    q = q.order(sortField, { ascending });

    // Pagination
    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({
      results: data || [],
      page: pageNum,
      pageSize: limit,
      total: count ?? 0,
      hasMore: count ? offset + (data?.length || 0) < count : false
    });
  } catch (err) {
    console.error('Search folders error:', err);
    res.status(500).json({ error: 'Search folders failed' });
  }
});

// ...keep the rest of your routes below...

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

// Fetch all owners for these files:
const ownerIds = [...new Set(files.map(f => f.owner_id))];

const { data: owners, error: ownersError } = await supabase
  .from('users')
  .select('id, email')
  .in('id', ownerIds);

if (ownersError) {
  return res.status(500).json({ error: ownersError.message });
}

// Map ownerId => email for easy lookup
const ownerEmailMap = Object.fromEntries(owners.map(o => [o.id, o.email]));

  const results = files.map(f => ({
    id: f.id,
    name: f.name,
    shared_by: ownerEmailMap[f.owner_id] || f.owner_id  ,
    shared_at: permissions.find(p => p.file_id === f.id)?.created_at
  }));

  return res.json(results);
});



// Example: In your files.js or recent.js router
router.get('/recent', authMiddleware, async (req, res) => {
  const user = req.user;

  // Get recent files for the user, ordered by updated/created date
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('owner_id', user.id)
    .eq('is_deleted', false)
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });

  res.json(data); // Respond with array of recent files
});

// In files.js or starred.js router
// ⭐ Get all starred items (files + folders)
router.get('/starred', authMiddleware, async (req, res) => {
  const user = req.user;

  // Get starred files
  const { data: files, error: fileError } = await supabase
    .from('files')
    .select('id, name, is_starred, created_at')
    .eq('owner_id', user.id)
    .eq('is_starred', true);

  // Get starred folders
  const { data: folders, error: folderError } = await supabase
    .from('folders')
    .select('id, name, is_starred, created_at')
    .eq('owner_id', user.id)
    .eq('is_starred', true);

  if (fileError || folderError) {
    return res.status(500).json({ error: fileError?.message || folderError?.message });
  }

  // Mark type for frontend
  const allStarred = [
    ...files.map((f) => ({ ...f, type: "file" })),
    ...folders.map((f) => ({ ...f, type: "folder" })),
  ];

  res.json(allStarred);
});




// ⭐ Toggle star for file
router.patch('/files/:id/star', authMiddleware, async (req, res) => {
  const user = req.user;
  const { starred } = req.body; // true/false

  const { data, error } = await supabase
    .from('files')
    .update({ is_starred: starred })
    .eq('id', req.params.id)
    .eq('owner_id', user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ⭐ Toggle star for folder
router.patch('/folders/:id/star', authMiddleware, async (req, res) => {
  const user = req.user;
  const { starred } = req.body;

  const { data, error } = await supabase
    .from('folders')
    .update({ is_starred: starred })
    .eq('id', req.params.id)
    .eq('owner_id', user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});






// In your files.js (or new trash.js) router
// Helper to get full breadcrumb path for a folder recursively
async function getAllTrashItems(parentId, userId) {
  const items = [];

  try {
    console.log(`[getAllTrashItems] Fetching items for parentId: ${parentId}, userId: ${userId}`);
    // Fetch folders under the current parentId
    let foldersQuery = supabase
      .from('folders')
      .select('id, name, parent_id, updated_at, created_at')
      .eq('owner_id', userId)
      .eq('is_deleted', true);

    let filesQuery = supabase
      .from('files')
      .select('id, name, folder_id, updated_at, created_at')
      .eq('owner_id', userId)
      .eq('is_deleted', true);

    // Conditionally apply parentId or null check
    if (parentId !== null) {
      foldersQuery = foldersQuery.eq('parent_id', parentId);
      filesQuery = filesQuery.eq('folder_id', parentId);
    } else {
      foldersQuery = foldersQuery.is('parent_id', null);
      filesQuery = filesQuery.is('folder_id', null);
    }

    const { data: folders, error: foldersError } = await foldersQuery;
    if (foldersError) {
      console.error('[getAllTrashItems] Folders query error:', {
        message: foldersError.message,
        code: foldersError.code,
        details: foldersError.details,
      });
      throw foldersError;
    }
    console.log(`[getAllTrashItems] Fetched ${folders?.length || 0} folders`);

    const { data: files, error: filesError } = await filesQuery;
    if (filesError) {
      console.error('[getAllTrashItems] Files query error:', {
        message: filesError.message,
        code: filesError.code,
        details: filesError.details,
      });
      throw filesError;
    }
    console.log(`[getAllTrashItems] Fetched ${files?.length || 0} files`);

    // Add current level files and folders
    items.push(...(files || []).map(f => ({ ...f, type: 'file' })));
    items.push(...(folders || []).map(f => ({ ...f, type: 'folder' })));

    // Recursively fetch items from subfolders
    if (parentId) {
      for (const folder of folders || []) {
        console.log(`[getAllTrashItems] Recursing into folder ${folder.id}`);
        const subItems = await getAllTrashItems(folder.id, userId);
        items.push(...subItems);
      }
    }

    return items;
  } catch (err) {
    console.error('[getAllTrashItems] Error:', {
      message: err.message,
      stack: err.stack,
      details: err.details,
    });
    throw err;
  }
}

async function getFolderBreadcrumbs(folderId) {
  const breadcrumbs = [];
  let currentId = folderId;
  while (currentId) {
    console.log(`[getFolderBreadcrumbs] Fetching breadcrumb for folder: ${currentId}`);
    if (currentId === null || currentId === 'null') {
      console.log('[getFolderBreadcrumbs] Breaking due to null folderId');
      break;
    }
    const { data: folder, error } = await supabase
      .from('folders')
      .select('id, name, parent_id')
      .eq('id', currentId)
      .single();

    if (error || !folder) {
      console.error('[getFolderBreadcrumbs] Error or folder not found:', {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      break;
    }
    breadcrumbs.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parent_id;
  }
  breadcrumbs.unshift({ id: 'root', name: 'Trash' });
  console.log(`[getFolderBreadcrumbs] Generated breadcrumbs:`, breadcrumbs);
  return breadcrumbs;
}

router.get('/trash', authMiddleware, async (req, res) => {
  try {
    console.log(`[trashRoute] Request received for user ${req.user?.id || 'unknown'}, parentId: ${req.query.parentId}`);
    if (!req.user) {
      console.error('[trashRoute] No user found in request');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let parentId = req.query.parentId;
    if (!parentId || parentId === 'null' || parentId === '') {
      parentId = null;
    } else {
      const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (!uuidRegex.test(parentId)) {
        return res.status(400).json({ error: 'Invalid parentId format' });
      }
    }

    console.log(`[trashRoute] Starting trash fetch for parentId: ${parentId}, userId: ${req.user.id}`);
    const allItems = await getAllTrashItems(parentId, req.user.id);

    const files = allItems.filter(item => item.type === 'file');
    const folders = allItems.filter(item => item.type === 'folder');

    let breadcrumbs = [{ id: 'root', name: 'Trash' }];
    if (parentId && parentId !== 'null') { // Only fetch breadcrumbs if parentId is a valid UUID
      breadcrumbs = await getFolderBreadcrumbs(parentId);
    }

    console.log(`[trashRoute] Successfully fetched: files=${files.length}, folders=${folders.length}, breadcrumbs=${breadcrumbs.length}`);
    res.json({
      success: true,
      files,
      folders,
      breadcrumbs,
    });
  } catch (err) {
    console.error('[trashRoute] Error occurred:', {
      message: err.message,
      stack: err.stack,
      details: err.details,
    });
    res.status(500).json({ error: 'Failed to fetch trash contents', details: err.message });
  }
});

/*
router.get('/trash', authMiddleware, async (req, res) => {
  try{
  const user = req.user;
 
    let parentId = req.query.parentId;

if (!parentId || parentId === 'null') {
  parentId = null;
}

const filesQuery = supabase.from('files').select('*').eq('owner_id', user.id).eq('is_deleted', true);
const foldersQuery = supabase.from('folders').select('*').eq('owner_id', user.id).eq('is_deleted', true);

if (parentId === null) {
  filesQuery.is('folder_id', null);
  foldersQuery.is('parent_id', null);
} else {
  filesQuery.eq('folder_id', parentId);
  foldersQuery.eq('parent_id', parentId);
}

const { data: files, error: filesError } = await filesQuery;
const { data: folders, error: foldersError } = await foldersQuery;



    if (filesError || foldersError) {

    const errMsg = filesError?.message || foldersError?.message || 'Failed to fetch trash';

    return res.status(500).json({ error: errMsg });

  }

  // For each file and folder, get breadcrumbs
  // Breadcrumb for the current parentId
    let breadcrumbs = [];
    if (parentId) {
      breadcrumbs = await getFolderBreadcrumbs(parentId); // you already have this helper
    } else {
      breadcrumbs = [{ id: "root", name: "Trash" }];
    }

  res.json({
    success: true,
   files,
   folders,
   breadcrumbs
  });
}
catch(err){
  console.error('Trash fetch error:', err);
  res.status(500).json({ error: 'Failed to fetch trash contents' });

}
});*/

async function cascadeRestoreFolder(folderId) {
  await supabase.from('folders').update({ is_deleted: false }).eq('id', folderId);

  console.log("DEBUG: About to use folder_id for DB operation:", folderId, typeof folderId);

  // Restore files in this folder
  await supabase.from('files').update({ is_deleted: false }).eq('folder_id', folderId);

  // Get subfolders and restore recursively
  const { data: subfolders } = await supabase.from('folders').select('id').eq('parent_id', folderId);
  if (subfolders?.length) {
    for (const subfolder of subfolders) {
      await cascadeRestoreFolder(subfolder.id);
    }
  }
}






router.post('/trash/restore/file/:id', authMiddleware, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const { data: file } = await supabase.from('files').select('owner_id').eq('id', id).single();
  if (!file || file.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed to restore this file.' });
  }

  await supabase.from('files').update({ is_deleted: false }).eq('id', id);
  res.json({ success: true, message: 'File restored.' });
});

router.post('/trash/restore/folder/:id', authMiddleware, async (req, res) => {
  // Similar ownership check and restore
  const user = req.user;
  const { id } = req.params;

  const { data: folder } = await supabase.from('folders').select('owner_id').eq('id', id).single();
  if (!folder || folder.owner_id !== user.id) {
    return res.status(403).json({ error: 'Not allowed to restore this folder.' });
  }

  // Optional: You may want cascading restore for subfolders/files
  await cascadeRestoreFolder(id);
  res.json({ success: true, message: 'Folder restored.' });
});




router.get("/user/profile", authMiddleware, async (req, res) => {
  try {
    const user = req.user

    // Get user storage info
    const { data: files, error: filesError } = await supabase
      .from("files")
      .select("size_bytes")
      .eq("owner_id", user.id)
      .eq("is_deleted", false)

    if (filesError) throw filesError

    const usedStorage = files.reduce((acc, f) => acc + f.size_bytes, 0)
    const totalStorage = 1024 * 1024 * 500 // 500MB per user

    // Get file counts
    const { count: fileCount, error: fileCountError } = await supabase
      .from("files")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("is_deleted", false)

    if (fileCountError) throw fileCountError

    // Get folder counts
    const { count: folderCount, error: folderCountError } = await supabase
      .from("folders")
      .select("*", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("is_deleted", false)

    if (folderCountError) throw folderCountError

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.email.split("@")[0],
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(user.email)}&background=4285f4&color=fff`,
      },
      storage: {
        used: usedStorage,
        total: totalStorage,
        percentage: Math.round((usedStorage / totalStorage) * 100),
      },
      stats: {
        filesCount: fileCount || 0,
        foldersCount: folderCount || 0,
      },
      joinedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error("Profile fetch error:", err)
    res.status(500).json({ error: "Failed to fetch user profile" })
  }
});

router.get("/notifications", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .order("timestamp", { ascending: false })
      .limit(10);

    if (error) throw error;

    res.json({
      notifications,
      unreadCount: notifications.filter((n) => !n.read).length,
    });
  } catch (err) {
    console.error("Notifications fetch error:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});


router.patch("/notifications/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { read } = req.body;

  try {
    const { data, error } = await supabase
      .from("notifications")
      .update({ read })
      .eq("id", id)
      .eq("user_id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error("Mark notification read error:", err);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// routes/notifications.js
router.get("/notifications/stream", authMiddleware, async (req, res) => {
  const token = req.query.token;
  const user = req.user;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendNotification = (notification) => {
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  };

  // Listen for changes (simplest: poll every 5 seconds)
  const interval = setInterval(async () => {
    const { data: newNotifications } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .eq("read", false)
      .order("timestamp", { ascending: false })
      .limit(5);

    newNotifications.forEach(sendNotification);
  }, 5000);

  req.on("close", () => clearInterval(interval));
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