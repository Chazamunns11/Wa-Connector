-- Pin search_path on the two public functions Supabase's security advisor
-- flags (lint 0011_function_search_path_mutable). Both bodies already use
-- schema-qualified names or pg_catalog built-ins only, so an empty path is safe.

alter function public.set_updated_at() set search_path = '';

alter function public.ghl_outbound_awaiting_read(timestamptz, int) set search_path = '';
