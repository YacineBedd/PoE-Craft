// Public Supabase configuration — safe to commit and ship to the browser.
//
// The anon key is a *public* client key: it only lets the client attempt
// requests. What data those requests can actually read or write is enforced
// server-side by Postgres Row-Level Security. The secret service_role key is
// never referenced here and never reaches the browser.
export const SUPABASE_URL = 'https://bawwaigclfkmdghntkum.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhd3dhaWdjbGZrbWRnaG50a3VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0MzcwODcsImV4cCI6MjEwMTAxMzA4N30.oQjuAhW1lj44rcStOyi9xvoxgZqt2f9p1AU_0ycbbj8';
