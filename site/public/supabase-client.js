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

    // --- Global UI Helpers: Scroll-to-Hide Navigation ---
    let lastScrollY = window.scrollY;
    const scrollThreshold = 10;

    window.addEventListener('scroll', () => {
        const currentScrollY = window.scrollY;
        const header = document.querySelector('header');
        const bottomNav = document.querySelector('nav.fixed.bottom-0');
        
        if (!header || !bottomNav) return;

        // Scrolling Down -> Hide bars
        if (currentScrollY > lastScrollY + scrollThreshold && currentScrollY > 100) {
            header.classList.add('nav-hidden-top');
            bottomNav.classList.add('nav-hidden-bottom');
        } 
        // Scrolling Up -> Show both bars
        else if (currentScrollY < lastScrollY - scrollThreshold || currentScrollY <= 0) {
            header.classList.remove('nav-hidden-top');
            bottomNav.classList.remove('nav-hidden-bottom');
        }

        lastScrollY = currentScrollY;
    }, { passive: true });

    // --- Global Mobile Menu Drawer ---
    const injectMobileMenu = () => {
        if (document.getElementById('mobile-drawer')) return;
        
        const drawer = document.createElement('div');
        drawer.id = 'mobile-drawer';
        drawer.className = 'fixed inset-0 z-[100] translate-x-[-100%] transition-transform duration-300 ease-in-out';
        drawer.innerHTML = `
            <div id="mobile-drawer-overlay" class="absolute inset-0 bg-black/50 backdrop-blur-sm opacity-0 transition-opacity duration-300"></div>
            <div class="absolute left-0 top-0 bottom-0 w-[280px] bg-surface shadow-2xl flex flex-col p-6">
                <div class="flex justify-between items-center mb-8">
                    <span class="text-xl font-black tracking-tighter text-primary">Share, Instead.</span>
                    <span id="close-mobile-menu" class="material-symbols-outlined cursor-pointer text-stone-500">close</span>
                </div>
                <div class="flex flex-col gap-6">
                    <a href="index.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">home</span> Home</a>
                    <a href="explore.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">explore</span> Explore</a>
                    <a href="circles.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">group</span> Circles</a>
                    <a href="messages.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">chat_bubble</span> Inbox</a>
                    <a href="activity.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">notifications</span> Activity</a>
                    <div class="h-[1px] bg-stone-200 my-2"></div>
                    <a href="profile.html" class="flex items-center gap-4 text-stone-800 font-bold text-lg"><span class="material-symbols-outlined">person</span> My Profile</a>
                </div>
            </div>
        `;
        document.body.appendChild(drawer);

        const openMenu = () => {
            drawer.classList.remove('translate-x-[-100%]');
            drawer.querySelector('#mobile-drawer-overlay').classList.replace('opacity-0', 'opacity-100');
        };

        const closeMenu = () => {
            drawer.classList.add('translate-x-[-100%]');
            drawer.querySelector('#mobile-drawer-overlay').classList.replace('opacity-100', 'opacity-0');
        };

        // Listen for all triggers
        document.addEventListener('click', (e) => {
            if (e.target.closest('.mobile-menu-trigger')) openMenu();
            if (e.target.closest('#close-mobile-menu') || e.target.closest('#mobile-drawer-overlay')) closeMenu();
        });
    };

    injectMobileMenu();
}
