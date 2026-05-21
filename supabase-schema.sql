-- ① binders 테이블
create table public.binders (
  id         bigserial primary key,
  user_id    uuid references auth.users on delete cascade not null,
  name       text    not null default '새 바인더',
  color      text    not null default '#6060ff',
  type       text    not null default '9포켓',
  pages      int     not null default 5,
  sort_order int     not null default 0,
  created_at timestamptz default now()
);

-- ② cards 테이블
create table public.cards (
  id         bigserial primary key,
  binder_id  bigint references public.binders on delete cascade not null,
  sp         int  not null,   -- spread(페이지) 번호
  side       text not null,   -- 'L' or 'R'
  slot       int  not null,   -- 포켓 인덱스
  image_url  text not null,   -- data URL 또는 https URL
  created_at timestamptz default now(),
  unique(binder_id, sp, side, slot)
);

-- ③ Row Level Security (본인 데이터만 접근 가능)
alter table public.binders enable row level security;
alter table public.cards   enable row level security;

create policy "자기 바인더 관리" on public.binders
  for all using (auth.uid() = user_id);

create policy "자기 카드 관리" on public.cards
  for all using (
    auth.uid() = (select user_id from public.binders where id = binder_id)
  );

-- ④ Storage 버킷 (업로드한 사진 저장용)
insert into storage.buckets (id, name, public) values ('card-images', 'card-images', true);

create policy "인증된 사용자 업로드" on storage.objects
  for insert with check (auth.uid() is not null and bucket_id = 'card-images');

create policy "공개 읽기" on storage.objects
  for select using (bucket_id = 'card-images');

create policy "본인 삭제" on storage.objects
  for delete using (auth.uid()::text = (storage.foldername(name))[1] and bucket_id = 'card-images');
