<?php

namespace App\Http\Controllers;

use App\Events\VideoSync;
use App\Models\Room;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Support\Str as SupportStr;
use Inertia\Inertia;
use App\Events\UserStartedEvent;
use App\Events\UserJoinedEvent;

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
        $name = Str::upper(Str::random(6));
        $room = Room::create([
            'name' => $name,
            'slug' => $name,
            'youtube_video_id' => $request->youtube_url,
        ]);
        return redirect()->route('rooms.show', ['name' => $name]);
    }

    // Render watch page
    public function show($name)
    {
        $room = Room::where('name', $name)->firstOrFail();
        return Inertia::render('Watch', ['room' => $room]);
    }

    public function sync(Request $request, $name)
    {
        $payload = $request->only(['event', 'time']);
        $source = $request->input('source', 'unknown-source');

        try {
            // Create the event
            $event = new \App\Events\VideoSync($name, $payload, $source);

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

            $channelName = 'public-room.' . $name;
            $eventName = 'sync';
            $data = [
                'payload' => $payload,
                'room_name' => $name,
                'source' => $source
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'payload' => $payload,
                'room_name' => $name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }

    public function userStarted(Request $request, $name)
    {
        $source = $request->input('source', 'unknown-source');

        try {
            // Create the event
            $event = new \App\Events\UserStartedEvent($name, $source);

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

            $channelName = 'public-room-users-started.' . $name;
            $eventName = 'user-started';
            $data = [
                'room_name' => $name,
                'source' => $source
            ];

            // Direct trigger to Pusher
            $pusher->trigger($channelName, $eventName, $data);

            return response()->json([
                'success' => true,
                'message' => 'Sync event broadcast successfully',
                'room_name' => $name,
                'source' => $source
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to broadcast sync event: ' . $e->getMessage()
            ], 500);
        }
    }

    public function userJoined(Request $request, $name)
    {
        $source = $request->input('source', 'unknown-source');

        // Log the request
        \Log::info('User joined received', [
            'room_name' => $name,
            'source' => $source,
            'user_id' => auth()->id(),
            'ip' => $request->ip()
        ]);

        // Broadcast the event to request the state
        broadcast(new UserJoinedEvent($name, $source));

        return response()->json(['message' => 'User joined broadcasted']);
    }

    public function getUsers(Room $room)
    {
        $users = \App\Models\User::all()->pluck('id')->toArray();

        return response()->json(['users' => $users]);
    }
}
