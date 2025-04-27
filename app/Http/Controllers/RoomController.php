<?php

namespace App\Http\Controllers;

use App\Events\VideoSync;
use App\Models\Room;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Support\Str as SupportStr;
use Inertia\Inertia;

class RoomController extends Controller
{
    // Show creation form
    public function create()
    {
        return Inertia::render('CreateRoom');
    }

    // Handle form submission
    public function storeWeb(Request $request)
    {
        $request->validate(['youtube_url' => 'required|url']);
        $code = Str::upper(Str::random(6));
        $room = Room::create([
            'name' => $code,
            'slug' => $code,
            'youtube_video_id' => $request->youtube_url,
        ]);
        return redirect()->route('rooms.show', ['code' => $code]);
    }

    // Render watch page
    public function show($code)
    {
        $room = Room::where('name', $code)->firstOrFail();
        return Inertia::render('Watch', ['room' => $room]);
    }

    public function sync(Request $request, $room_name)
    {
        $payload = $request->only(['event', 'time']);
        $source = $request->input('source', 'unknown-source');
        
        // Log the sync request
        \Log::info('Sync request received', [
            'room_name' => $room_name,
            'payload' => $payload,
            'source' => $source,
            'user_id' => auth()->id(),
            'ip' => $request->ip()
        ]);
        
        try {
            // Create the event
            $event = new \App\Events\VideoSync($room_name, $payload, $source);
            
            // Broadcast the event - use event() helper for more direct broadcasting
            event($event);
            
            // Alternative direct broadcast to ensure it's working
            $pusher = new \Pusher\Pusher(
                env('PUSHER_APP_KEY'),
                env('PUSHER_APP_SECRET'),
                env('PUSHER_APP_ID'),
                [
                    'cluster' => env('PUSHER_APP_CLUSTER'),
                    'useTLS' => true,
                ]
            );
            
            $channelName = 'public-room.' . $room_name;
            $eventName = 'sync';
            $data = [
                'payload' => $payload,
                'room_name' => $room_name,
                'source' => $source
            ];
            
            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);
            
            \Log::info('Event broadcast completed', [
                'channel' => $channelName,
                'event' => $eventName,
                'data' => $data
            ]);
            
            return response()->json([
                'success' => true, 
                'message' => 'Sync event broadcast successfully',
                'payload' => $payload, 
                'room_name' => $room_name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            \Log::error('Failed to broadcast sync event', [
                'room_name' => $room_name,
                'payload' => $payload,
                'source' => $source,
                'error' => $e->getMessage()
            ]);
            
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }
}
