import {supabase} from '../supabaseClient.js';

export async function findOrCreateFolder(ownerId, folderName, parentId = null) {

    // Defensive: convert "null" or "root" strings to actual null
  if (!parentId || parentId === "null" || parentId === "root") {
    parentId = null;
  }
  // Try to find existing folder
  let { data: folder, error } = await supabase
    .from('folders')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('name', folderName)
    .eq('parent_id', parentId)
    .eq('is_deleted', false)
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') { // ignore no rows error
    throw error;
  }

  if (folder) {
    return folder.id;
  } else {
    // Create folder
    const { data, error: insertError } = await supabase
      .from('folders')
      .insert([
        {
          owner_id: ownerId,
          name: folderName,
          parent_id: parentId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select('id')
      .single();

    if (insertError){
        console.error("findOrCreateFolder insert error:", insertError.message);
    throw insertError;
    }
        
    return data.id;
  }
}


