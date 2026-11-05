-- FIT FUEL schema (applied automatically by Netlify on deploy)
create table if not exists settings (
  key   text primary key,
  value text not null
);

create table if not exists codes (
  code     text primary key,
  sponsor  text not null default '',
  pct      integer not null,
  max_uses integer not null default 0,
  exp      text not null default '',
  used     integer not null default 0,
  active   boolean not null default true,
  created  timestamptz not null default now()
);

create table if not exists subs (
  id      text primary key,
  token   text not null,
  created timestamptz not null default now(),
  status  text not null default 'active',
  data    jsonb not null
);

create table if not exists rate_limits (
  key          text primary key,
  n            integer not null,
  window_start timestamptz not null default now()
);
