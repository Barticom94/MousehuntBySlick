// Module: Map Invites
// One click invites as many friends as the treasure map has open slots, using the game's own endpoints
// (hg.utils.User.getFriends for the friend list, hg.utils.TreasureMapUtil.getMapInfo / sendInvites for the map),
// in a single request instead of ticking names in the invite dialog.
// Not capped at the open slots: it invites every eligible friend so the slots fill as fast as possible.
// Everything goes through ajax calls in the background; no dialog or page element is touched.
{
  const MAP_FIELDS = ['map_name', 'wanted_poster_name', 'event_map_name'];

  /**
   * Every friend worth inviting, best first: friends on no map, then favourites among the rest, then friends already on another
   * map (the game's dialog lets you invite those too). Skips hunters on this map and ones already invited.
   * Pure, so it can be tested without the game.
   */
  const pickInvitees = (friends, map, favourites = []) => {
    const skip = new Set([...(map.invited_hunters || []), ...(map.hunters || []).map((h) => h.sn_user_id)].map(String));
    const fav = new Set((favourites || []).map(String));
    const slots = Math.max(0, (Number(map.max_hunters) || 0) - (Number(map.num_active_hunters) || 0));
    const busy = (f) => MAP_FIELDS.some((k) => f[k]);
    const rank = (f) => (busy(f) ? (fav.has(String(f.sn_user_id)) ? 1 : 2) : 0);
    const picked = friends.filter((f) => f && f.sn_user_id && !skip.has(String(f.sn_user_id)))
      .map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i)
      .map(({ f }) => String(f.sn_user_id));
    return { slots, ids: picked };
  };
  window.mhMapInvites = Object.assign(window.mhMapInvites || {}, { pickInvitees });

  const call = (fn, ...args) => new Promise((ok, err) => fn(...args, ok, err));

  MH.register({
    id: 'map-invites',
    name: 'Map Invites',
    description: 'One click invites every eligible friend to your current treasure map so its open slots fill fast.',
    requires: gameRequires,
    init(ctx) {
      let busy = false;
      ctx.setStatus('Ready');

      const run = async () => {
        if (busy) return;
        busy = true;
        try {
          if (typeof hg === 'undefined' || !hg.utils?.TreasureMapUtil || !hg.utils?.User) throw new Error('map tools not found on this page');
          const q = user.quests?.QuestRelicHunter;
          const mapId = q?.default_map_id;
          if (!mapId) { ctx.setStatus('You have no treasure map selected', 'warn'); return; }
          ctx.setStatus('Checking the map...');
          const info = await call(hg.utils.TreasureMapUtil.getMapInfo, mapId);
          const map = info.treasure_map;
          if (!map) throw new Error('the game returned no map');
          if (!map.is_owner && map.can_send_invites === false) { ctx.setStatus('You can\'t send invites for this map', 'warn'); return; }
          const open = (Number(map.max_hunters) || 0) - (Number(map.num_active_hunters) || 0);
          if (open <= 0) { ctx.setStatus(`${map.name} is full (${map.num_active_hunters}/${map.max_hunters} hunters)`, 'warn'); return; }
          const friends = await call(hg.utils.User.getFriends, MAP_FIELDS);
          const { slots, ids } = pickInvitees(friends, map, hg.utils.TreasureMapUtil.getFavouriteFriends());
          if (!ids.length) { ctx.setStatus(`No friends left to invite (all friends are already on the map or invited)`, 'warn'); return; }
          ctx.setStatus(`Inviting ${ids.length}...`);
          // One request for everyone. If the server turns that down (a size limit), retry in smaller batches.
          let sent = 0;
          for (const size of [ids.length, 100, 25]) {
            if (size > ids.length && size !== 100 && size !== 25) continue;
            try {
              for (let i = sent; i < ids.length; i += size) {
                const res = await call(hg.utils.TreasureMapUtil.sendInvites, mapId, ids.slice(i, i + size));
                if (res && res.success === false) throw new Error('refused');
                sent = Math.min(ids.length, i + size);
              }
              break;
            } catch (e) { ctx.log.warn('invite batch failed at size', size, e); }
          }
          if (!sent) throw new Error('the game refused the invites');
          ctx.setStatus(`Invited ${sent} friends to ${map.name} (${slots} open slot${slots === 1 ? '' : 's'}${sent < ids.length ? `, ${ids.length - sent} not sent` : ''})`);
        } catch (e) {
          ctx.log.warn(e);
          ctx.setStatus(`Invites failed: ${e?.message || e}`, 'warn');
        } finally { busy = false; }
      };

      return { actions: [{ label: 'Invite max friends to my map', run }] };
    },
  });
}
