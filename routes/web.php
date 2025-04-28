<?php

use Illuminate\Support\Facades\Route;
use Inertia\Inertia;
use Illuminate\Support\Facades\Auth;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Broadcast;

use App\Http\Controllers\RoomController;


Route::get('/', function () {
    return Inertia::render('welcome');
})->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('dashboard', function () {
        return Inertia::render('dashboard');
    })->name('dashboard');

    Route::get('/rooms/create', [RoomController::class, 'create'])->name('rooms.create');
    Route::get('/rooms/{name}', [RoomController::class, 'show'])->name('rooms.show');
    Route::post('/rooms', [RoomController::class, 'storeWeb'])->name('rooms.store');

    // Explicit broadcasting auth route
    Route::post('/broadcasting/auth', function (Request $request) {
        $pusher = new Pusher\Pusher(
            env('PUSHER_APP_KEY'),
            env('PUSHER_APP_SECRET'),
            env('PUSHER_APP_ID'),
            [
                'cluster' => env('PUSHER_APP_CLUSTER'),
                'useTLS' => true,
            ]
        );

        $socketId = $request->socket_id;
        $channelName = $request->channel_name;
        $user = Auth::user();

        \Log::info('Broadcasting auth request', [
            'socket_id' => $socketId,
            'channel_name' => $channelName,
            'user_id' => $user ? $user->id : null
        ]);

        $auth = $pusher->authorizeChannel($channelName, $socketId);

        return response()->json($auth);
    });

    Route::post('/api/rooms/{name}/sync', [RoomController::class, 'sync']);

    Route::post('/api/rooms/{name}/user-started', [RoomController::class, 'userStarted']);
    Route::post('/api/rooms/{name}/user-joined', [RoomController::class, 'userJoined']);
    Route::get('/api/rooms/{name}/users', [RoomController::class, 'getUsers']);
});

Route::middleware(['auth', 'verified'])->get('/api/user', function (Request $request) {
    return $request->user();
});

require __DIR__ . '/settings.php';
require __DIR__ . '/auth.php';
