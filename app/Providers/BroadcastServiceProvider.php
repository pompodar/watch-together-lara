<?php

namespace App\Providers;

use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\ServiceProvider;

class BroadcastServiceProvider extends ServiceProvider
{
    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // We're defining the broadcast routes in web.php now
        // to avoid HTML responses instead of JSON
        
        require base_path('routes/channels.php');
    }
} 