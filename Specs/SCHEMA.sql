-- Share, Instead. Database Schema
-- Designed for Supabase (PostgreSQL)

-- 1. Profiles Table (Extends Supabase Auth)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  full_name TEXT,
  avatar_url TEXT,
  bio TEXT,
  reputation_score DECIMAL(3, 2) DEFAULT 5.00,
  carbon_saved_kg DECIMAL DEFAULT 0,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Circles Table
CREATE TABLE circles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  created_by UUID REFERENCES profiles(id),
  is_private BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Circle Members (Many-to-Many)
CREATE TABLE circle_members (
  circle_id UUID REFERENCES circles(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member', -- 'member', 'admin'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (circle_id, profile_id)
);

-- 4. Items (Tools, Skills, Surplus)
CREATE TABLE items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  circle_id UUID REFERENCES circles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL, -- 'Garden Tools', 'Power Tools', 'Kitchen', 'Skills', 'Surplus'
  image_url TEXT,
  status TEXT DEFAULT 'available', -- 'available', 'loaned', 'hidden'
  condition TEXT, -- 'New', 'Good', 'Worn'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Borrow Requests
CREATE TABLE requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  borrower_id UUID REFERENCES profiles(id),
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'declined', 'returned'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Messages (Chat)
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_id UUID REFERENCES profiles(id),
  receiver_id UUID REFERENCES profiles(id),
  item_id UUID REFERENCES items(id), -- Contextual item for the chat
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------
-- ROW LEVEL SECURITY (RLS) SETTINGS
-- ---------------------------------------------------------

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE circles ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Profiles: Everyone can view, only owners can edit
CREATE POLICY "Public profiles are viewable by everyone" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Circles: Members can view
CREATE POLICY "Circles are viewable by members" ON circles FOR SELECT 
  USING (EXISTS (SELECT 1 FROM circle_members WHERE circle_id = id AND profile_id = auth.uid()) OR NOT is_private);

-- Items: Members of the same circle can view
CREATE POLICY "Items are viewable by circle members" ON items FOR SELECT 
  USING (EXISTS (SELECT 1 FROM circle_members WHERE circle_id = items.circle_id AND profile_id = auth.uid()));

-- Messages: Only sender or receiver can view
CREATE POLICY "Messages are viewable by sender or receiver" ON messages FOR SELECT 
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can insert own messages" ON messages FOR INSERT WITH CHECK (auth.uid() = sender_id);
