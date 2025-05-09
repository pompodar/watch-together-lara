<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class RoomUser extends Model
{
    protected $fillable = ['room_id', 'user_id', 'is_host', 'user_code'];
}
