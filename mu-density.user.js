// ==UserScript==
// @id             mu-density
// @name           IITC plugin: show MU density for each field
// @category       Info
// @version        0.0.1
// @namespace      https://github.com/jonatkins/ingress-intel-total-conversion
// @description    [vorlon-0.0.1] When fields are created, calculate and display the MU density for the field in question
// @include        https://www.ingress.com/intel*
// @include        http://www.ingress.com/intel*
// @match          https://www.ingress.com/intel*
// @match          http://www.ingress.com/intel*
// @grant          none
// ==/UserScript==

// TODO:
// - give more descriptive names for the fields than just lat/long
// - add support for sorting by distance from current location
// - add support for exporting data, so that one can analyze offline instead
//   of constantly reloading intel

function wrapper(plugin_info) {
// ensure plugin framework is there, even if iitc is not yet loaded
if(typeof window.plugin !== 'function') window.plugin = function() {};

// PLUGIN START ////////////////////////////////////////////////////////

// use own namespace for plugin
window.plugin.mudensity = function() {};

window.plugin.mudensity.toRad = function(arg) {
   return arg * Math.PI / 180;
}

window.plugin.mudensity.haversine = function(lat1,lat2,lng1,lng2) {
   var Lat = window.plugin.mudensity.toRad((lat2-lat1)/1E6);
   var Lng = window.plugin.mudensity.toRad((lng2-lng1)/1E6);

   var R = 6371; // radius in kilometers

   var a = Math.sin(Lat/2) * Math.sin (Lat/2) +
           Math.cos(window.plugin.mudensity.toRad(lat1/1E6)) *
           Math.cos(window.plugin.mudensity.toRad(lat2/1E6)) *
           Math.sin(Lng/2) * Math.sin (Lng/2);
   var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
   return R * c;
}

window.plugin.mudensity.area = function(f) {
   var a = window.plugin.mudensity.haversine(f.portal1.lat, f.portal2.lat,
                                             f.portal1.lng, f.portal2.lng);
   var b = window.plugin.mudensity.haversine(f.portal2.lat, f.portal3.lat,
                                             f.portal2.lng, f.portal3.lng);
   var c = window.plugin.mudensity.haversine(f.portal3.lat, f.portal1.lat,
                                             f.portal3.lng, f.portal1.lng);

   var s = (a+b+c)/2;
   return Math.sqrt(s * (s - a) * (s - b) * (s - c));
}

window.plugin.mudensity.matchFieldAndLink = function(d,f,g,ts,portal1) {
   var point = [0,0,0];

   // fudge factor: the field should be created after the link, but
   // apparently that's not always the case?  Either way 40 seconds
   // should be more than enough time to sync. :/
   // And in some cases this does give wrong results due to two fields created
   // within seconds of each other by way of different links. Bah.
   if (Math.abs(ts - g) > 40000)
     return true;

   for (var i = 0; i < 3; i++)
   {
     if (d.points[i].latE6 == portal1.portal.lat
         && d.points[i].lngE6 == portal1.portal.lng)
     {
       point[i] = 1;
     } else if (d.points[i].latE6 == f.target.lat
                && d.points[i].lngE6 == f.target.lng)
     {
       point[i] = 2;
     }
   }

   // not a match.
   if (point[0] + point[1] + point[2] < 3)
     return true;

   for (var i = 0; i < 3; i++)
   {
     if (point[i] == 0)
     {
       var portal3 = { lat: d.points[i].latE6, lng: d.points[i].lngE6 };
       f.points.push(portal3);
     }
   }

   if (f.points.length == f.fields.length) {
     // just handle the easy case for now, where there's only one field.
     if (f.points.length == 1)
     {
       var candidate = { portal1: portal1.portal,
                         portal2: f.target,
                         portal3: f.points[0],
                         mu: f.fields[0],
                         timestamp: g,
                         area: 0,
                         center: null
       };

       delete portal1.data[g];
       if (!Object.keys(portal1.data).length)
         delete portal1;
       // fields with 1MU are kept up to this point to disambiguate multiple
       // fields created at the same time but they should not be counted
       // because they give us an upper bound on density but no lower bound
       if (candidate.mu == 1)
         return false;

       candidate.area = window.plugin.mudensity.area(candidate);
       candidate.center = {
            lat: (candidate.portal1.lat + candidate.portal2.lat + candidate.portal3.lat)/3,
            lng: (candidate.portal1.lng + candidate.portal2.lng + candidate.portal3.lng)/3
       };
       var key = candidate.portal1.lat.toString() + "_" + candidate.portal1.lng.toString()
                 + "_" + candidate.timestamp.toString() + "_"
                 + candidate.portal3.lat.toString() + "_"
                 + candidate.portal3.lng.toString();
       window.plugin.mudensity.listFields[key] = candidate;
       return false;
     } else {
       // FIXME: if we have more than one field along the same link, should
       // we assume that the larger field is the one with the greater MU score?
//       alert("More than one matching field from " + portal1.portal.name
//             + " to " + f.target.name + ", skipping for now.");
     }
   }
}

window.plugin.mudensity.handleField = function(data) {

  var d = data.field.options.data;
  var ts = data.field.options.timestamp;

  $.each(window.plugin.mudensity.potentials, function(g,portal1) {
      $.each(portal1.data, function(g,f) {
          if (!f.target)
            return true;
          return window.plugin.mudensity.matchFieldAndLink(d,f,g,ts,portal1);
      });
  });
}

window.plugin.mudensity.handleData = function(data) {

  // the link and field can come in any order in the data, so we have to
  // handle the possibility of the field being either first or last.  If the
  // link makes *multiple* fields, however, we punt, since we don't know for
  // sure which MU maps to which field.  This can be determined by seeing that
  // there is more than one portal that both source and target portals are
  // linked to.
  var candidate = { portal1: null, portal2: null, portal3: null, mu: 0,
                    timestamp: null, area: 0, center: null };

  // We should add some handling here to clean up any stale entries
  // in our 'potentials' table ('stale' defined as a link without a field)
  // since otherwise they get double-loaded and never cleaned up.  This should
  // be an ok place to do that, since link+field will normally come together
  // in the same batch of data.
  $.each(data.raw.success, function(ind, json) {

    // find portal information
    var skipThisMessage = false;
    var isField = false;
    var portal1 = null;
    var portal2 = null;
    var portal3 = null;
    var mu = 0;
    var ts = json[1];

    $.each(json[2].plext.markup, function(ind, markup) {
      switch(markup[0]) {
      case 'TEXT':
        // This could eventually be useful because we do get the count
        // of MU destroyed; but skip for now
        if(markup[1].plain.indexOf('destroyed the Link') !== -1
          || markup[1].plain.indexOf('destroyed a Control Field') !== -1
          || markup[1].plain.indexOf('Your Link') !== -1) {
          skipThisMessage = true;
          return false;
        }
        if (isField) {
          var res = parseInt(markup[1].plain, 10);
          if (res > 0) {
            mu = res;
          }
        }
        if(markup[1].plain.indexOf('created a Control Field') !== -1) {
          isField = true;
        }
        break;
      case 'PORTAL':
        var portal = { name: markup[1].name,
                       lat: markup[1].latE6,
                       lng: markup[1].lngE6 };
        if (!portal1)
          portal1 = portal;
        else
          portal2 = portal;
        break;
      }

    });

    // skip all lines that are neither links nor fields
    if (!portal1 || (!mu && !portal2))
      return true;

    var loc = portal1.lat.toString() + "_" + portal1.lng.toString();
    if (!window.plugin.mudensity.potentials[loc])
      window.plugin.mudensity.potentials[loc] = {
                   portal: portal1,
                   data: {}, };

    var potentials = window.plugin.mudensity.potentials[loc].data;

    if (!potentials[ts])
    {
      potentials[ts] = {fields: [], points: [], target: null, };
    }
    // FIXME: each time we reread the data, we wind up pushing a new set
    // of arrays on here.  We need a way to flush these when they've been
    // seen before.
    if (mu)
      potentials[ts]['fields'].push(mu);

    if (portal2)
      potentials[ts]['target'] = portal2;

    window.plugin.mudensity.potentials[loc].data = potentials;

  });
}



window.plugin.mudensity.potentials = {};
window.plugin.mudensity.listFields = {};
window.plugin.mudensity.displayFields = [];
window.plugin.mudensity.sortBy = 5; // fifth column: density
window.plugin.mudensity.sortOrder = -1;

/*
 * plugins may add columns by appending their specifiation to the following list. The following members are supported:
 * title: String
 *     Name of the column. Required.
 * value: function(field)
 *     The raw value of this column. Can by anything. Required, but can be dummy implementation if sortValue and format
 *     are implemented.
 * sortValue: function(value, field)
 *     The value to sort by. Optional, uses value if omitted. The raw value is passed as first argument.
 * sort: function(valueA, valueB, fieldA, fieldB)
 *     Custom sorting function. See Array.sort() for details on return value. Both the raw values and the field objects
 *     are passed as arguments. Optional. Set to null to disable sorting
 * format: function(cell, field, value)
 *     Used to fill and format the cell, which is given as a DOM node. If omitted, the raw value is put in the cell.
 * defaultOrder: -1|1
 *     Which order should by default be used for this column. -1 means descending. Default: 1
 */


window.plugin.mudensity.columns = [
  {
    title: "Latitude",
    value: function(field) { return (field.center.lat/1E6).toFixed(6).toString(); },
    sortValue: function(value, field) { return field.center.lat; },
    format: function(cell, field, value) {
      $(cell)
        .append(plugin.mudensity.pointLink(field,value));
    }
  },
  {
    title: "Longitude",
    value: function(field) { return (field.center.lng/1E6).toFixed(6).toString(); },
    sortValue: function(value, field) { return field.center.lng; },
    format: function(cell, field, value) {
      $(cell)
        .append(plugin.mudensity.pointLink(field,value));
    }
  },
  {
    title: "Area",
    value: function(field) { return field.area.toFixed(3).toString(); },
    sortValue: function(value, field) { return field.area; },
    format: function(cell, field, value) {
      $(cell)
        .append(value + " km<sup>2</sup>");
    }
  },
  {
    title: "total MU",
    value: function(field) { return field.mu.toString(); },
    sortValue: function(field) { return field.mu; },
  },  
  {
    title: "MU density",
    value: function(field) {
        var low = (field.mu-.5)/field.area;
        var high = (field.mu+.5)/field.area;
        return low.toFixed(3).toString() +
               "-" + high.toFixed(3).toString();
    },
    sortValue: function(value, field) { return field.mu/field.area; },
    format: function(cell, field, value) {
      $(cell)
        .append(value + " MU/km<sup>2</sup>");
    }
  },
];

//fill the displayFields array with fields avaliable on the map
window.plugin.mudensity.getFields = function() {
  var retval=false;

  // reset, to avoid listing the same field multiple times.
  window.plugin.mudensity.displayFields = [];

  var displayBounds = map.getBounds();

  // we may have potential fields that have shown up after the field
  // itself was rendered, so process them now.
  $.each(window.plugin.mudensity.potentials, function(g,portal1) {
      $.each(portal1.data, function(g,f) {
          // If we get here, we saw a field but are missing the target
          // (which means an annoying boundary condition in the data).
          // clean it up.
          if (!f.target)
          {
//            alert("field at " + portal1.portal.name + " but no link; this shouldn't happen.");
            delete portal1.data[g];
            return true;
          }
          // The much more normal scenario of a link with no field.  We
          // assume the field isn't coming, and just remove it.
          if (!f.fields.length)
          {
            delete portal1.data[g];
            return true;
          }

          $.each(window.fields, function(guid,field) {
              var d = field.options.data;
              var ts = field.options.timestamp;
              return window.plugin.mudensity.matchFieldAndLink(d,f,g,ts,portal1);
          });
      });
      if (!Object.keys(portal1.data).length)
        delete window.plugin.mudensity.potentials[g];
  });

  $.each(window.plugin.mudensity.listFields, function(i, field) {
    retval=true;

    // cache values and DOM nodes
    var obj = { field: field, values: [], sortValues: [] };

    var row = document.createElement('tr');
    obj.row = row;

    var cell = row.insertCell(-1);
    cell.className = 'alignR';

    window.plugin.mudensity.columns.forEach(function(column, i) {
      cell = row.insertCell(-1);
      cell.className = 'alignR';

      var value = column.value(field);
      obj.values.push(value);

      obj.sortValues.push(column.sortValue ? column.sortValue(value, field) : value);

      if(column.format) {
        column.format(cell, field, value);
      } else {
        cell.textContent = value;
      }
    });

    window.plugin.mudensity.displayFields.push(obj);
  });

  return retval;
}

window.plugin.mudensity.displayMU = function() {
  var list;
  window.plugin.mudensity.sortBy = 4;
  window.plugin.mudensity.sortOrder = -1;

  if (window.plugin.mudensity.getFields()) {
    list = window.plugin.mudensity.portalTable(window.plugin.mudensity.sortBy, window.plugin.mudensity.sortOrder);
  } else {
    list = $('<table class="noPortals"><tr><td>Nothing to show!</td></tr></table>');
  };

  if(window.useAndroidPanes()) {
    $('<div id="mudensity" class="mobile">').append(list).appendTo(document.body);
  } else {
    dialog({
      html: $('<div id="mudensity">').append(list),
      dialogClass: 'ui-dialog-mudensity',
      title: 'MU Density: ' + Object.keys(window.plugin.mudensity.listFields).length + ' ' + (Object.keys(window.plugin.mudensity.listFields).length == 1 ? 'field' : 'fields'),
      id: 'portal-list',
      width: 700
    });
  }
}

window.plugin.mudensity.portalTable = function(sortBy, sortOrder) {
  // save the sortBy/sortOrder
  window.plugin.mudensity.sortBy = sortBy;
  window.plugin.mudensity.sortOrder = sortOrder;

  var fields = window.plugin.mudensity.displayFields;
  var sortColumn = window.plugin.mudensity.columns[sortBy];

  fields.sort(function(a, b) {
    var valueA = a.sortValues[sortBy];
    var valueB = b.sortValues[sortBy];

    if(sortColumn.sort) {
      return sortOrder * sortColumn.sort(valueA, valueB, a.field, b.field);
    }

    return sortOrder *
      (valueA < valueB ? -1 :
      valueA > valueB ?  1 :
      0);
  });

  var table, row, cell;
  var container = $('<div>');

  var length = window.plugin.mudensity.displayFields.length;

  table = document.createElement('table');
  table.className = 'portals';
  container.append(table);

  var thead = table.appendChild(document.createElement('thead'));
  row = thead.insertRow(-1);

  cell = row.appendChild(document.createElement('th'));
  cell.textContent = '#';

  window.plugin.mudensity.columns.forEach(function(column, i) {
    cell = row.appendChild(document.createElement('th'));
    cell.textContent = column.title;
    if(column.sort !== null) {
      cell.classList.add("sortable");
      if(i == window.plugin.mudensity.sortBy) {
        cell.classList.add("sorted");
      }

      $(cell).click(function() {
        var order;
        if(i == sortBy) {
          order = -sortOrder;
        } else {
          order = column.defaultOrder < 0 ? -1 : 1;
        }

        $('#mudensity').empty().append(window.plugin.mudensity.portalTable(i, order));
      });
    }
  });

  fields.forEach(function(obj, i) {
    var row = obj.row
    if(row.parentNode) row.parentNode.removeChild(row);

    row.cells[0].textContent = i+1;

    table.appendChild(row);
  });

  container.append('<div class="disclaimer">Click on column headers to sort by that column.</div>');

  return container;
}

// pointLink - single click: zoom to location
// code from getPortalLink function by xelio from iitc: AP List - https://raw.github.com/breunigs/ingress-intel-total-conversion/gh-pages/plugins/ap-list.user.js
window.plugin.mudensity.pointLink = function(field,text) {
 var lat = (field.center.lat/1E6).toFixed(6);
 var lng = (field.center.lng/1E6).toFixed(6);

  var perma = '/intel?ll='+lat.toString()+','+lng.toString()+'&z=15';

  // jQuery's event handlers seem to be removed when the nodes are removed from the DOM
  var link = document.createElement("a");
  link.textContent = text;
  link.href = perma;
  return link;
}

window.plugin.mudensity.onPaneChanged = function(pane) {
  if(pane == "plugin-mudensity")
    window.plugin.mudensity.displayMU();
  else
    $("#mudensity").remove()
};

var setup =  function() {
  if(window.useAndroidPanes()) {
    android.addPane("plugin-mudensity", "MU Density", "ic_action_paste");
    addHook("paneChanged", window.plugin.mudensity.onPaneChanged);
  } else {
    $('#toolbox').append(' <a onclick="window.plugin.mudensity.displayMU()" title="Show MU density for created fields">MU Density</a>');
  }

  $("<style>")
    .prop("type", "text/css")
    .html("#mudensity.mobile {\n  background: transparent;\n  border: 0 none !important;\n  height: 100% !important;\n  width: 100% !important;\n  left: 0 !important;\n  top: 0 !important;\n  position: absolute;\n  overflow: auto;\n}\n\n#mudensity table {\n  margin-top: 5px;\n  border-collapse: collapse;\n  empty-cells: show;\n  width: 100%;\n  clear: both;\n}\n\n#mudensity table td, #mudensity table th {\n  background-color: #1b415e;\n  border-bottom: 1px solid #0b314e;\n  color: white;\n  padding: 3px;\n}\n\n#mudensity table th {\n  text-align: center;\n}\n\n#mudensity table .alignR {\n  text-align: right;\n}\n\n#mudensity table.portals td {\n  white-space: nowrap;\n}\n\n#mudensity table th.sortable {\n  cursor: pointer;\n}\n\n#mudensity table .portalTitle {\n  min-width: 120px !important;\n  max-width: 240px !important;\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n}\n\n#mudensity .sorted {\n  color: #FFCE00;\n}\n\n#mudensity table tr.none td {\n  background-color: #000;\n}\n\n#mudensity .disclaimer {\n  margin-top: 10px;\n  font-size: 10px;\n}\n\n")
    .appendTo("head");

  addHook('publicChatDataAvailable', window.plugin.mudensity.handleData);
  addHook('fieldAdded', window.plugin.mudensity.handleField);
  window.chat.backgroundChannelData('plugin.mudensity', 'all', true);    //enable this plugin's interest in 'all' COMM

}

// PLUGIN END //////////////////////////////////////////////////////////


setup.info = plugin_info; //add the script info data to the function as a property
if(!window.bootPlugins) window.bootPlugins = [];
window.bootPlugins.push(setup);
// if IITC has already booted, immediately run the 'setup' function
if(window.iitcLoaded && typeof setup === 'function') setup();
} // wrapper end
// inject code into site context
var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) info.script = { version: GM_info.script.version, name: GM_info.script.name, description: GM_info.script.description };
script.appendChild(document.createTextNode('('+ wrapper +')('+JSON.stringify(info)+');'));
(document.body || document.head || document.documentElement).appendChild(script);


