/**
 * Optional online features.
 *
 * Leave these blank and the game works exactly as it always has: scores stay
 * on your own device and reported photos are hidden only for you.
 *
 * Fill them in to switch on the worldwide leaderboard and shared photo
 * reports. Both are backed by a free Supabase project — see
 * docs/online-setup.md for the four SQL statements that create the tables.
 *
 * The anon key below is *designed* to be public and safe to commit: Supabase
 * row-level security decides what it can actually do. It is still a key any
 * visitor can read and use, so read the "What this cannot do" section of
 * docs/online-setup.md before relying on the leaderboard for anything.
 */
const BEACH_GUESSER_CONFIG = {
  supabaseUrl: "",      // e.g. "https://abcdefgh.supabase.co"
  supabaseAnonKey: "",  // the project's public anon key

  // How many separate reports hide a photo for everybody.
  reportThreshold: 3,

  // Entries shown on each leaderboard board.
  leaderboardSize: 20
};
