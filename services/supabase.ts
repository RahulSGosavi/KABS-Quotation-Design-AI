import { createClient } from '@supabase/supabase-js';

// Configuration from User Request
const SUPABASE_URL = 'https://lzcmsmixorgzttrsxmyt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Y21zbWl4b3JnenR0cnN4bXl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczMjUxODksImV4cCI6MjA4MjkwMTE4OX0.Oj1_hjj6AdP6jdM_HXPcijXoLJJ6q6qe8DRMaNweag0';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Y21zbWl4b3JnenR0cnN4bXl0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzMyNTE4OSwiZXhwIjoyMDgyOTAxMTg5fQ.Lwlkl0f9nbs0HYFXmMptyg-knqYI8lj1GVf5aVNvbHM';

// Standard Client (for read operations)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Admin Client (for Storage Buckets & Table Management)
// NOTE: In a real production app, this key should stay server-side. 
// Used here to satisfy the "Direct Connection" and "Create Separate Table/Storage" requirement from the frontend.
// We disable auth persistence here to avoid "Multiple GoTrueClient instances" warning since admin doesn't need user session storage.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: 'kabs_admin_auth_token' // Unique key to prevent conflict with public client
  }
});
