// Supabase Client Initialization
// Depends on config.js being loaded beforehand

// Check for Vite environment variables first, then fallback to window.ENV
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || window.ENV?.SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || window.ENV?.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Supabase credentials not found. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
} else {
    window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    console.log('Supabase initialized successfully.');

    // Helper function to handle Google Login
    window.loginWithGoogle = async function(redirectTo = 'explore.html') {
        const { data: { session } } = await window.supabaseClient.auth.getSession();
        if (session) {
            window.location.href = redirectTo;
            return;
        }

        const { data, error } = await window.supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + '/' + redirectTo
            }
        });

        if (error) {
            console.error('Login error:', error.message);
            alert('Login failed: ' + error.message);
        }
    };

    // Helper function to handle Logout
    window.logout = async function() {
        const { error } = await window.supabaseClient.auth.signOut();
        if (error) {
            console.error('Logout error:', error.message);
        } else {
            window.location.href = 'index.html';
        }
    };

    // Helper function to protect routes
    window.requireAuth = async function(redirectUrl = 'join-community.html') {
        const { data: { session }, error } = await window.supabaseClient.auth.getSession();
        
        if (error || !session) {
            console.warn('Unauthorized access. Redirecting to login.');
            window.location.href = redirectUrl;
            return null;
        }
        return session;
    };

    // Optional: Listen to auth changes globally (e.g. to catch sign outs)
    window.supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' && !window.location.pathname.includes('join-community.html') && window.location.pathname !== '/' && !window.location.pathname.includes('index.html')) {
            window.location.href = 'join-community.html';
        }
    });
}
