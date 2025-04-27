<?php

use App\Models\Room;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Log;

Broadcast::channel('room.{room}', function ($user, $room) {
    Log::info('Channel authorization attempt', [
        'user_id' => $user->id,
        'room' => $room,
        'channel' => 'room.' . $room
    ]);
    
    // Allow any authenticated user to join any room
    return true;
});
