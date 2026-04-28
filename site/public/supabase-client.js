// Supabase Client Initialization
// Depends on config.js being loaded beforehand

if (!window.ENV || !window.ENV.SUPABASE_URL || !window.ENV.SUPABASE_ANON_KEY) {
    console.error('Supabase credentials not found. Please ensure config.js is loaded.');
} else {
    // Initialize the Supabase client
    window.supabaseClient = supabase.createClient(
        window.ENV.SUPABASE_URL,
        window.ENV.SUPABASE_ANON_KEY
    );
    console.log('Supabase initialized successfully.');

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
