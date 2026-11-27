begin;
-- Доступ к измерениям — только действующим участникам закрытого круга «Маяка».
create table public.mayak_weather_state (
 station_id text primary key check(station_id='astrakhan-lit'),
 received_at timestamptz not null,
 measured_at timestamptz not null,
 sensor_valid boolean not null,
 temperature double precision,
 humidity double precision,
 last_good_at timestamptz,
 rssi integer not null check(rssi between -127 and 0),
 firmware text not null check(length(firmware) between 1 and 32),
 boot_id uuid not null,
 sequence bigint not null check(sequence>0),
 weather jsonb,
 check(temperature is null or temperature between -50 and 150),
 check(humidity is null or humidity between 0 and 100),
 check(not sensor_valid or (temperature is not null and humidity is not null))
);
create table public.mayak_weather_samples (
 station_id text not null references public.mayak_weather_state(station_id) on delete cascade,
 bucket timestamptz not null,
 measured_at timestamptz not null,
 temperature double precision not null check(temperature between -50 and 150),
 humidity double precision not null check(humidity between 0 and 100),
 primary key(station_id,bucket)
);
create table mayak_private.weather_keys (
 station_id text primary key check(station_id='astrakhan-lit'),
 token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
 enabled boolean not null default true
);
alter table public.mayak_weather_state enable row level security;
alter table public.mayak_weather_samples enable row level security;
alter table mayak_private.weather_keys enable row level security;
revoke all on public.mayak_weather_state, public.mayak_weather_samples,mayak_private.weather_keys from public,anon,authenticated;
grant select on public.mayak_weather_state,public.mayak_weather_samples to authenticated;
create policy weather_state_members on public.mayak_weather_state for select to authenticated using((select mayak_private.is_member()));
create policy weather_samples_members on public.mayak_weather_samples for select to authenticated using((select mayak_private.is_member()));

-- Только служебная Edge Function может вызвать запись. Ключ ESP не является ключом Supabase.
create function mayak_private.weather_ingest(p_hash text,p_payload jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare
 v_station text:=p_payload->>'station_id'; v_key mayak_private.weather_keys;
 v_previous public.mayak_weather_state;
 v_time timestamptz;v_boot uuid;v_sequence bigint;v_valid boolean;v_t double precision;v_h double precision;
 v_rssi integer;v_firmware text;v_weather jsonb;v_now timestamptz:=clock_timestamp();
begin
 select * into v_key from mayak_private.weather_keys where station_id=v_station and enabled for update;
 if not found or p_hash is null or p_hash<>v_key.token_hash then raise exception 'Неверный ключ станции.' using errcode='28000';end if;
 if jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>4096 or
    jsonb_typeof(p_payload->'sensor_valid')<>'boolean' or
    jsonb_typeof(p_payload->'sequence')<>'number' or
    jsonb_typeof(p_payload->'rssi')<>'number' then raise exception 'Неверный пакет.' using errcode='22023';end if;
 v_time:=(p_payload->>'measured_at')::timestamptz;v_boot:=(p_payload->>'boot_id')::uuid;
 v_sequence:=(p_payload->>'sequence')::bigint;v_valid:=(p_payload->>'sensor_valid')::boolean;
 v_rssi:=(p_payload->>'rssi')::integer;v_firmware:=p_payload->>'firmware';
 if v_time is null or v_time<v_now-interval '10 minutes' or v_time>v_now+interval '60 seconds' or
    v_boot is null or v_sequence is null or v_sequence<=0 or v_rssi is null or v_rssi not between -127 and 0 or
    v_valid is null or v_firmware is null or length(v_firmware) not between 1 and 32
 then raise exception 'Неверные метаданные.' using errcode='22023';end if;
 if v_valid then
   v_t:=(p_payload->>'temperature')::double precision;v_h:=(p_payload->>'humidity')::double precision;
   if v_t is null or v_h is null or not(v_t between -50 and 150) or not(v_h between 0 and 100)
   then raise exception 'Неверное измерение.' using errcode='22023';end if;
 end if;
 select * into v_previous from public.mayak_weather_state where station_id=v_station;
 if found then
   if v_time<=v_previous.measured_at or (v_boot=v_previous.boot_id and v_sequence<=v_previous.sequence)
   then return jsonb_build_object('ok',true,'duplicate',true);end if;
   if v_now-v_previous.received_at<interval '30 seconds' then raise exception 'Слишком частые пакеты.' using errcode='P0001';end if;
 end if;
 v_weather:=case when jsonb_typeof(p_payload->'weather')='object' then p_payload->'weather' else v_previous.weather end;
 insert into public.mayak_weather_state(station_id,received_at,measured_at,sensor_valid,temperature,humidity,last_good_at,rssi,firmware,boot_id,sequence,weather)
 values(v_station,v_now,v_time,v_valid,v_t,v_h,case when v_valid then v_time else v_previous.last_good_at end,v_rssi,v_firmware,v_boot,v_sequence,v_weather)
 on conflict(station_id) do update set received_at=excluded.received_at,measured_at=excluded.measured_at,sensor_valid=excluded.sensor_valid,
 temperature=excluded.temperature,humidity=excluded.humidity,last_good_at=excluded.last_good_at,rssi=excluded.rssi,
 firmware=excluded.firmware,boot_id=excluded.boot_id,sequence=excluded.sequence,weather=excluded.weather;
 if v_valid then
   insert into public.mayak_weather_samples values(v_station,date_trunc('minute',v_time),v_time,v_t,v_h)
   on conflict(station_id,bucket) do update set measured_at=excluded.measured_at,temperature=excluded.temperature,humidity=excluded.humidity;
 end if;
 -- По одной последней записи в минуту; история сервера сохраняется 30 дней.
 delete from public.mayak_weather_samples where station_id=v_station and bucket<v_now-interval '30 days';
 return jsonb_build_object('ok',true,'duplicate',false,'received_at',v_now);
end;
$$;
create function public.mayak_weather_ingest(p_hash text,p_payload jsonb) returns jsonb
 language sql security invoker set search_path='' as $$select mayak_private.weather_ingest(p_hash,p_payload);$$;
revoke all on function mayak_private.weather_ingest(text,jsonb),public.mayak_weather_ingest(text,jsonb) from public,anon,authenticated;
grant usage on schema mayak_private to service_role;
grant execute on function mayak_private.weather_ingest(text,jsonb),public.mayak_weather_ingest(text,jsonb) to service_role;

create function mayak_private.weather_get(p_minutes integer) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not mayak_private.is_member() then raise exception 'Войдите в Маяк.' using errcode='42501';end if;
 if p_minutes is null or p_minutes not in (30,60,180,360,720,1440) then raise exception 'Неверный период.' using errcode='22023';end if;
 return jsonb_build_object('server_time',now(),'station',jsonb_build_object('id','astrakhan-lit','city','Астрахань','location','5-я Литейная','timezone','Europe/Astrakhan'),
   'latest',(select to_jsonb(s)-'boot_id'-'sequence' from public.mayak_weather_state s where station_id='astrakhan-lit'),
   'history',coalesce((select jsonb_agg(jsonb_build_object('time',measured_at,'temperature',temperature,'humidity',humidity) order by measured_at)
     from public.mayak_weather_samples where station_id='astrakhan-lit' and measured_at>=now()-make_interval(mins=>p_minutes)),'[]'::jsonb));
end;
$$;
create function public.mayak_weather_get(p_minutes integer default 720) returns jsonb
 language sql security invoker set search_path='' as $$select mayak_private.weather_get(p_minutes);$$;
revoke all on function mayak_private.weather_get(integer),public.mayak_weather_get(integer) from public,anon;
grant execute on function mayak_private.weather_get(integer),public.mayak_weather_get(integer) to authenticated;
commit;
