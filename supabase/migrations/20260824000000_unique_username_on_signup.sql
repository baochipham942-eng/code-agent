-- ============================================================================
-- 修复：同邮箱前缀的第二个用户注册直接失败（N-SIGNUP-USERNAME）
-- ============================================================================
-- 病灶：profiles.username 带 UNIQUE 约束（20240115000000_init_sync_tables.sql:16），
--   而 username 是从邮箱前缀自动切出来的，同一形状散在三处：
--     ① handle_new_user() 触发器 :243  split_part(NEW.email, '@', 1)
--     ② authService.ts:422（邮箱注册）  email.split('@')[0]
--     ③ authService.ts:489（OAuth 首登）data.user.email?.split('@')[0]
--   三处都只写 ON CONFLICT (id)，挡不住 username 冲突。
--   ⇒ linchen@a.com 注册过之后，linchen@b.com 再注册时 username 都是 'linchen'，
--     AFTER INSERT 触发器抛 unique_violation 回滚整个事务，第二个人根本注册不进来，
--     且看到的是数据库层 duplicate key 报错。
--
-- 修法（爸 2026-08-24 拍板「自动填」）：保留 UNIQUE 与自动填，把「填什么」收敛到
--   数据库这一处，撞了就加数字后缀。TS 侧两处随本迁移一并停止写 username
--   （见同单 authService.ts 改动），避免三处竞相生成又互相覆盖。
-- ============================================================================

-- 生成一个不与现有 profiles.username 冲突的用户名。
-- base 为空时退回 'user'。并发下仍可能两个事务同时选中同一候选，
-- 由 handle_new_user() 的 unique_violation 重试兜底。
CREATE OR REPLACE FUNCTION public.generate_unique_username(base_name TEXT)
RETURNS TEXT AS $$
DECLARE
  base TEXT := COALESCE(NULLIF(TRIM(base_name), ''), 'user');
  candidate TEXT;
  suffix INT := 0;
BEGIN
  LOOP
    candidate := CASE WHEN suffix = 0 THEN base ELSE base || suffix::TEXT END;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE username = candidate);
    suffix := suffix + 1;
    -- ponytail: 线性扫到 50 就改随机后缀，够用；真出现同前缀上千用户再换 hash 分桶
    IF suffix > 50 THEN
      RETURN base || '_' || substr(md5(random()::TEXT), 1, 8);
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 重建注册触发器：username 撞了就换下一个候选，绝不让用户名把注册整个卡死。
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  base TEXT := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'username'), ''),
    split_part(NEW.email, '@', 1)
  );
  attempt INT := 0;
BEGIN
  LOOP
    BEGIN
      INSERT INTO public.profiles (id, username, created_at, updated_at)
      VALUES (NEW.id, public.generate_unique_username(base), NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      -- 并发注册撞在同一个候选上：重算一次候选再试
      attempt := attempt + 1;
      IF attempt >= 5 THEN
        -- 兜底：username 留空（列可空且 UNIQUE 允许多个 NULL），
        -- 显示链 nickname || username || email || id 有兜底，绝不因为它注册失败
        INSERT INTO public.profiles (id, username, created_at, updated_at)
        VALUES (NEW.id, NULL, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING;
        RETURN NEW;
      END IF;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 触发器本体不变（AFTER INSERT ON auth.users），此处不重建。
