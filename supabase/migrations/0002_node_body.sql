-- =============================================================================
-- 0002: long-form Markdown body on nodes
--
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- `text` stays the short one-line title shown in the list (and later the
-- graph). `body` holds long-form Markdown: nuance, citations, reasoning.
-- =============================================================================

alter table public.nodes
  add column if not exists body text not null default '';

-- History trigger: include body in the "did anything meaningful change" check
-- so body edits are recorded and pure echoes are still skipped.
create or replace function public.nodes_record_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.node_history (node_id, op, data, changed_by)
    values (new.id, 'insert', to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    if row(new.parent_id, new.position, new.text, new.body, new.kind, new.deleted_at)
       is not distinct from
       row(old.parent_id, old.position, old.text, old.body, old.kind, old.deleted_at) then
      return new;
    end if;
    insert into public.node_history (node_id, op, data, changed_by)
    values (old.id, 'update', to_jsonb(old), auth.uid());
    return new;
  else
    insert into public.node_history (node_id, op, data, changed_by)
    values (old.id, 'delete', to_jsonb(old), auth.uid());
    return old;
  end if;
end;
$$;
