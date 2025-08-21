import { supabase } from '../supabaseClient.js';

export async function findOrCreateFolder(ownerId, folderName, parentId = null) {
  // Defensive: convert "null" or "root" strings to actual null with validation
  console.log("findOrCreateFolder called with parentId:", parentId, "type:", typeof parentId);
  if (parentId === undefined || parentId === "null" || parentId === "root" || parentId === "") {
    parentId = null;
  } else if (typeof parentId === "string") {
    parentId = parentId.trim();
  }
  console.log("Processed parentId:", parentId, "type:", typeof parentId);

  // Dynamically build the query based on parentId
  let query = supabase.from('folders').select('id').eq('owner_id', ownerId).eq('name', folderName).eq('is_deleted', false).limit(1);
  if (parentId === null) {
    query = query.is('parent_id', null); // Use .is() for null comparison
  } else {
    query = query.eq('parent_id', parentId); // Use .eq() for non-null UUIDs
  }

  let { data: folder, error } = await query.single();

  if (error && error.code !== 'PGRST116') { // Ignore no rows error
    console.error("Find folder error:", error.message);
    throw error;
  }

  if (folder) {
    console.log("Found existing folder id:", folder.id);
    return folder.id;
  } else {
    // Create folder with explicit null check
    console.log("Inserting new folder with parentId:", parentId);
    const { data, error: insertError } = await supabase
      .from('folders')
      .insert([
        {
          owner_id: ownerId,
          name: folderName,
          parent_id: parentId === null ? null : parentId, // Explicit null handling
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select('id')
      .single();

    if (insertError) {
      console.error("Insert folder error:", insertError.message);
      throw insertError;
    }
    console.log("Inserted folder id:", data.id);
    return data.id;
  }
}