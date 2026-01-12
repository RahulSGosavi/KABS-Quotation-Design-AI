import { Manufacturer, Project, NKBARules } from '../types';
import { supabase, supabaseAdmin } from './supabase';

const BUCKET_NAME = 'catalogs';

class StorageService {
  
  private bucketChecked = false;

  // --- Manufacturers ---

  async getManufacturers(): Promise<Manufacturer[]> {
    // 1. Try Supabase DB
    // FIX: Use supabaseAdmin to ensure we can read what we just wrote, avoiding RLS visibility issues for the 'Admin' view.
    try {
      const { data, error } = await supabaseAdmin.from('manufacturers').select('*');
      if (!error && data) {
        const list = data.map((row: any) => row.data as Manufacturer);
        // CACHE UPDATE: Ensure next load is instant by updating local storage with fresh data
        try { localStorage.setItem('kabs_local_manufacturers', JSON.stringify(list)); } catch(e) {}
        return list;
      }
    } catch (e) {
      console.error("Supabase fetch failed", e);
    }
    // 2. Fallback to minimal local storage if cloud fails
    const local = localStorage.getItem('kabs_local_manufacturers');
    return local ? JSON.parse(local) : [];
  }

  // New Method: Fetch heavy catalog only when needed
  async getManufacturerCatalog(mfgId: string): Promise<Record<string, Record<string, number>>> {
      try {
          const { data, error } = await supabase.storage
            .from(BUCKET_NAME)
            .download(`${mfgId}.json`);
          
          if (error) {
              console.warn("Catalog fetch error:", error);
              return {};
          }
          
          const text = await data.text();
          return JSON.parse(text);
      } catch (e) {
          console.error("Catalog download exception:", e);
          return {};
      }
  }

  // Optimization: Call this ONCE before batch operations
  async ensureBucket(): Promise<void> {
      if (this.bucketChecked) return;
      try {
          const { data: buckets } = await supabaseAdmin.storage.listBuckets();
          const bucketExists = buckets?.find(b => b.name === BUCKET_NAME);
          if (!bucketExists) {
              await supabaseAdmin.storage.createBucket(BUCKET_NAME, { public: true });
          }
          this.bucketChecked = true;
      } catch (e) {
          console.error("Bucket check failed", e);
      }
  }

  // Helper to upload an image found in Excel
  // Removed internal bucket check for performance in loops
  async uploadCatalogImage(mfgId: string, fileName: string, blob: Blob): Promise<string | null> {
      try {
          const path = `${mfgId}/images/${fileName}`;
          const { error } = await supabaseAdmin.storage
              .from(BUCKET_NAME)
              .upload(path, blob, { upsert: true, contentType: blob.type || 'image/png' });
          
          if (error) {
              console.error("Image upload error", error);
              return null;
          }

          const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);
          return publicData.publicUrl;
      } catch (e) {
          console.error("Image upload exception", e);
          return null;
      }
  }

  // Saving: Split metadata (DB) and Catalog (Bucket)
  async saveManufacturer(mfg: Manufacturer, fullCatalog?: Record<string, any>): Promise<void> {
    const catalogToSave = fullCatalog || mfg.catalog || {};
    const skuCount = Object.keys(catalogToSave).length;
    
    // 1. Prepare Lightweight Object
    // Remove Base64 Data from files to prevent payload too large errors
    const slimFiles = (mfg.files || []).map(f => ({
        ...f,
        data: undefined // Ensure we don't send large strings to JSON column
    }));

    const slimMfg: Manufacturer = {
        ...mfg,
        catalog: undefined, // Don't store catalog in DB row
        files: slimFiles,
        skuCount: skuCount
    };
    
    // UPDATE CACHE: Immediately update local storage so UI is fast on reload/re-mount
    try {
        const currentStr = localStorage.getItem('kabs_local_manufacturers');
        let current = currentStr ? JSON.parse(currentStr) : [];
        current = [...current.filter((m:Manufacturer) => m.id !== mfg.id), slimMfg];
        localStorage.setItem('kabs_local_manufacturers', JSON.stringify(current));
    } catch (e) { console.warn("Cache update failed", e); }

    // 2. Upload Catalog to Storage Bucket (The "Separate Data" Store)
    if (skuCount > 0) {
        try {
            await this.ensureBucket(); // Ensure bucket exists before saving catalog

            // Upload JSON file
            const blob = new Blob([JSON.stringify(catalogToSave)], { type: 'application/json' });
            const { error: uploadError } = await supabaseAdmin.storage
                .from(BUCKET_NAME)
                .upload(`${mfg.id}.json`, blob, { upsert: true });

            if (uploadError) console.error("Bucket Upload Error:", uploadError);

        } catch (e) {
            console.error("Bucket Operation Failed:", e);
        }
    }

    // 3. Save Metadata to Table
    try {
        const { error } = await supabaseAdmin.from('manufacturers').upsert({
            id: mfg.id,
            data: slimMfg
        });
        if (error) {
            console.error("Supabase UPSERT Error Details:", JSON.stringify(error, null, 2));
            throw error;
        }
    } catch (e: any) {
        console.error("Supabase DB Save Exception:", e.message || e);
    }
  }
  
  // New method: Update just the DB row (metadata) to allow quick file deletions without re-uploading catalog
  async saveManufacturerMetadata(mfg: Manufacturer): Promise<void> {
    const slimFiles = (mfg.files || []).map(f => ({
        ...f,
        data: undefined
    }));

    const slimMfg: Manufacturer = {
        ...mfg,
        catalog: undefined,
        files: slimFiles,
        // Keep existing skuCount intact
    };

    // UPDATE CACHE: Immediate UI sync
    try {
        const currentStr = localStorage.getItem('kabs_local_manufacturers');
        let current = currentStr ? JSON.parse(currentStr) : [];
        current = [...current.filter((m:Manufacturer) => m.id !== mfg.id), slimMfg];
        localStorage.setItem('kabs_local_manufacturers', JSON.stringify(current));
    } catch (e) { console.warn("Cache update failed", e); }

    try {
        const { error } = await supabaseAdmin.from('manufacturers').upsert({
            id: mfg.id,
            data: slimMfg
        });
        if (error) throw error;
    } catch (e: any) {
        console.error("Metadata save failed", e);
        throw e;
    }
  }

  async deleteManufacturer(id: string): Promise<void> {
    // 1. Delete from Cloud
    try {
        await supabaseAdmin.storage.from(BUCKET_NAME).remove([`${id}.json`]);
        const { error } = await supabaseAdmin.from('manufacturers').delete().eq('id', id);
        if (error) console.error("DB Delete Error", error);
    } catch(e) {
        console.warn("Supabase delete partial fail", e);
    }

    // 2. Delete from Local Storage (Critical for immediate UI sync/fallback)
    try {
        const local = localStorage.getItem('kabs_local_manufacturers');
        if (local) {
            const parsed = JSON.parse(local) as Manufacturer[];
            const updated = parsed.filter(m => m.id !== id);
            localStorage.setItem('kabs_local_manufacturers', JSON.stringify(updated));
        }
    } catch (e) {
        console.warn("Local storage delete fail", e);
    }
  }

  // --- Projects (Unchanged mostly, but robust) ---
  
  async getActiveProject(): Promise<Project | null> {
    const activeId = localStorage.getItem('kabs_active_project_id');
    if (!activeId) return null;

    // Try Local
    const localProjectsStr = localStorage.getItem('kabs_local_projects');
    if (localProjectsStr) {
        const projects = JSON.parse(localProjectsStr);
        const found = projects.find((p: Project) => p.id === activeId);
        if (found) return found;
    }
    return null; 
  }

  async saveActiveProject(project: Project): Promise<void> {
    localStorage.setItem('kabs_active_project_id', project.id);
    
    // Local Update
    const localProjectsStr = localStorage.getItem('kabs_local_projects');
    let projects: Project[] = localProjectsStr ? JSON.parse(localProjectsStr) : [];
    projects = [...projects.filter(p => p.id !== project.id), project];
    
    try {
        localStorage.setItem('kabs_local_projects', JSON.stringify(projects));
    } catch (e) {
        console.warn("Project local save failed (quota).");
    }

    // Cloud Sync (Best Effort)
    await supabase.from('projects').upsert({ id: project.id, data: project });
  }

  // --- NKBA Rules ---
  async getNKBARules(): Promise<NKBARules | null> {
    // Try Cloud First
    const { data } = await supabase.from('settings').select('*').eq('key', 'nkba_rules').single();
    if (data && data.value) {
         // CACHE UPDATE
         try { localStorage.setItem('kabs_local_nkba_rules', JSON.stringify(data.value)); } catch(e){}
         return data.value;
    }
    
    // Local fallback
    const local = localStorage.getItem('kabs_local_nkba_rules');
    return local ? JSON.parse(local) : null;
  }

  async saveNKBARules(rules: NKBARules): Promise<void> {
     // Cache update
     try { localStorage.setItem('kabs_local_nkba_rules', JSON.stringify(rules)); } catch (e) {}

     // Cloud Primary
     await supabaseAdmin.from('settings').upsert({ key: 'nkba_rules', value: rules });
  }
}

export const storage = new StorageService();