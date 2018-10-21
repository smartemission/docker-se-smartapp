$(document).ready(function () {

    var init_zoom=8;
    var init_center = new L.latLng([52.0, 5.5]);
    var cur_zoom=init_zoom;
    var cur_center = init_center;

    // Create Map with layers
    var map = new L.Map('map', {zoom: init_zoom, center: init_center});
    // var mapUrl = 'http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    var mapUrl = 'https://geodata.nationaalgeoregister.nl/tiles/service/wmts/brtachtergrondkaartgrijs/EPSG:3857/{z}/{x}/{y}.png';
    var mapAttrib = 'Basemap BRT from <a href="https://www.pdok.nl">Dutch Kadaster PDOK</a>';
    var mapTiles = new L.TileLayer(mapUrl, {attribution: mapAttrib});
    map.addLayer(mapTiles);

    // Precompile Handlebars.js Template
    var source = $("#entry-template").html();
    var template = Handlebars.compile(source);

    // URL of the Smart Emission SOS REST API
    var apiUrl = '/sosemu/api/v1';
    // apiUrl = 'https://data.smartemission.nl/sosemu/api/v1';

    // See http://stackoverflow.com/questions/11916780/changing-getjson-to-jsonp
    // Notice the callback=? . This triggers a JSONP call
    var stationsUrl = apiUrl + '/stations?format=json&callback=?';
    var markers = {};
    var oldMarkerId;

    // Split into categories for ease of templating: gasses, meteo and audio
    // See https://github.com/smartemission/smartemission/blob/master/etl/sensordefs.py for
    // sensor-component names
    // var gasIds = 'co2,o3,no2,co,o3raw,coraw,no2raw,pm10,pm2_5';
    // No Raw Values: https://github.com/smartemission/smartemission/issues/83
    var gasIds = 'co2,o3,no2,co,pm10,pm2_5';
    var meteoIds = 'temperature,pressure,humidity';
    var audioIds = 'noiseavg,noiselevelavg';
    var aqIndexesNL = {
        no2: [0, 30, 75, 125, 200],
        o3: [0, 40, 100, 180, 240],
        pm10: [0, 30, 75, 125, 200],
        pm2_5: [0, 20, 50, 90, 140]
    };
    var aqIndexesNLLegend =
        [
            {color: '#3399CC', fontColor: '#FFFFFF', text: 'Goed'},
            {color: '#FFFF00', fontColor: '#000000', text: 'Matig'},
            {color: '#FF9900', fontColor: '#000000', text: 'Onvoldoende'},
            {color: '#FF0000', fontColor: '#FFFFFF', text: 'Slecht'},
            {color: '#660099', fontColor: '#FFFFFF', text: 'Zeer Slecht'},
        ];


    // Create icon based on feature props and selected state
    function getAQIndex(component) {
        var indexValue = {color: '#FFFFFF', fontColor: '#000000', text: 'nvt'};
        var name = component.id;
        if (aqIndexesNL.hasOwnProperty(name)) {
            var value = component.lastValue.value;
            var indexArr = aqIndexesNL[name];
            var index = indexArr.length - 1;
            for (var i = 0; i < indexArr.length; i++) {
                if (value < indexArr[i]) {
                    break;
                }
                index = i;
            }
            if (index >= 0 && index < aqIndexesNLLegend.length) {
                indexValue = aqIndexesNLLegend[index];
            }
        }
        return indexValue;
    }

    // Create icon based on feature props and selected state
    function getMarkerIcon(feature, selected) {
        // Default
        var iconUrl = feature.properties['value_stale'] == '0' ? 'media/locatie-icon.png' : 'media/locatie-icon-stale.png';

        return new L.icon({
            iconUrl: selected ? 'media/locatie-icon-click.png' : iconUrl,
            iconSize: [24, 41],
            iconAnchor: [10, 40]
        });
    }
    var hoverPup;
    // Show the marker mouse over popup
    function show_marker_hover(e, feature) {
        // var props = feature.properties;
        // hoverPup = L.popup()
        //  .setLatLng(e.latlng)
        //  .setContent(props.label + ' <br>laatste meting: ' + props.last_update)
        //  .openOn(map);
        // return false;
    }

    // Hide the marker mouse over popup
    function hide_marker_hover(e, feature) {
        // if (hoverPup && map) {
        //     map.closePopup(hoverPup);
        //     hoverPup = undefined;
        // }
        // return false;
    }

    var projectInfo = {
        '1182': {'id_str': 'asenl', 'name': 'AirSensEUR NL', 'markers': []},
        '2008': {'id_str': 'gcn', 'name': 'Green Capital Nijmegen', 'markers': []},
        '2*': {'id_str': 'scll', 'name': 'Smart City Living Lab', 'markers': []},
        '0000': {'id_str': 'sen', 'name': 'Smart Emission Nijmegen', 'markers': []}
    };

    // Get project id string from station nr
    function getProject(station_id) {
        var projectId = '0000';
        if (station_id.length == 8) {
            projectId = station_id.slice(0, 4);
            if (projectId != '2008' && projectId != '1182') {
                projectId = '2*';
            } 
        }
        return projectInfo[projectId];
    }

    // Show the station side bar popup
    function show_station_popup(feature) {
        var stationId = feature.properties.id;
        var date = new Date(feature.properties.last_update.replace(' ', 'T'));
        var dateTime = date.toLocaleDateString('nl-NL') + ' ' + date.toLocaleTimeString('nl-NL') + " NL";
        feature.properties.last_update_fmt = dateTime;

        // Get project name from station id
        feature.properties.project_str = 'Onbekend';
        var project = getProject(stationId);
        if (project) {
            feature.properties.project_str = project.name;
        }

        var timeseriesUrl = apiUrl + '/timeseries?format=json&station=' + stationId + '&expanded=true&callback=?';

        $.getJSON(timeseriesUrl, function (data) {
            // See to which category an observation belongs by matching the label
            var gasses = [];
            var meteo = [];
            var audio = {};

            for (var idx in data) {
                var component = data[idx];
                var componentId = component.id;

                // Is it a gas?
                if (gasIds.indexOf(componentId) >= 0) {
                    gasses.push(component);
                    component['index'] = getAQIndex(component);
                    // Is it a meteo?
                } else if (meteoIds.indexOf(componentId) >= 0) {
                    meteo.push(component);

                    // Is it audio?
                } else if (audioIds.indexOf(componentId) >= 0) {
                    // Is it a audio?
                    audio[componentId] = component;
                    //
                    // if (componentId == 'noiselevelavg') {
                    //     component['offset'] = parseInt(component.lastValue.value) * 20 - 10;
                    // }
                }
            }

            // Create station data struct: splitting up component categories
            var stationData = {
                station: feature,
                gassesLegend: aqIndexesNLLegend,
                data: {
                    gasses: gasses,
                    meteo: meteo,
                    audio: audio
                }
            };

            // console.log(stationData);

            var html = template(stationData);

            // Hier met JQuery
            var sidebarElm = $("#sidebar");

            // sidebarElm clear first
            sidebarElm.empty();
            sidebarElm.append(html);
            sidebar.toggle();

            // Zoom to station and change icon to yellow

            // Get the Marker
            var markerClicked = markers[stationId];
            if (markerClicked) {
                var icon = getMarkerIcon(feature, true);
                markerClicked.setIcon(icon);

                // Reset previous clicked marker if exists
                if (oldMarkerId) {
                    var oldMarkerClicked = markers[oldMarkerId];
                    icon = getMarkerIcon(oldMarkerClicked.feature, false);
                    oldMarkerClicked.setIcon(icon);
                }

                // Save the clicked marker feature id, to reset
                oldMarkerId = stationId;
            }

            // Coordinaten geometrie (lon,lat) en LatLon object (lat, lon) moeten omgedraaid
            cur_zoom = map.getZoom();
            cur_center = map.getCenter();
            var zoomTo = feature.geometry.coordinates;
            map.setView(new L.latLng([zoomTo[1], zoomTo[0]]), 17);
        });
    }

    // get query params, see: http://blog.thematicmapping.org/2012/10/how-to-control-your-leaflet-map-with.html
    // and http://papermashup.com/read-url-get-variables-withjavascript/
    var query_params = {};
    window.location.href.replace(/[?&]+([^=&]+)=([^&]*)/gi, function (m, key, value) {
        query_params[key] = value;
    });

    // First get stations JSON object via REST
    $.getJSON(stationsUrl, function (data) {
        var markerCluster = L.markerClusterGroup();

        // Callback when getting stations
        var geojson = L.geoJson(data, {
            pointToLayer: function (feature, latlng) {
                // Create and save Marker
                var icon = getMarkerIcon(feature, false);
                var marker = L.marker(latlng, {icon: icon});
                markers[feature.properties.id] = marker;
                var project = getProject(feature.properties.id);
                if (project) {
                    project.markers.push(marker);
                }
                // marker.bindPopup("Popup content");
                return marker;
            }
        });

        geojson.on('mouseover', function (e) {
                show_marker_hover(e, feature);
            }).on('mouseout', function (e) {
                // hide_marker_hover(e, feature);
            }).on('click', function (e) {
                show_station_popup(e.layer.feature);
            });

        var subGroups = {};
        for (var projectId in projectInfo) {
            // Project param allows showing only project layer markers
            if (query_params.project && query_params.project !== projectInfo[projectId].id_str) {
                continue;
            }

            var subGroup = L.featureGroup.subGroup(markerCluster, projectInfo[projectId].markers);
            subGroup.addTo(map);
            subGroups[projectInfo[projectId].name] = subGroup;
        }

        markerCluster.addTo(map);
        var collapsed = false;
        L.control.layers([], subGroups,{collapsed: collapsed}).addTo(map);
        $(".leaflet-control-layers-overlays").prepend("<label>Projecten</label>");

        // Check query parameter to directly show station values
        if (query_params.station && markers[query_params.station]) {
            var feature = markers[query_params.station].feature;
            show_station_popup(feature);
        }
    });

    var sidebar = L.control.sidebar('sidebar', {
        closeButton: true,
        position: 'left'
    });
    map.addControl(sidebar);

    map.on('click', function () {
        sidebar.hide();
        map.setView(cur_center, cur_zoom);
        // map.setView([51.8348, 5.85], 12);
    });

    sidebar.on('show', function () {
        console.log('Sidebar will be visible.');
    });
    sidebar.on('shown', function () {
        console.log('Sidebar is visible.');
    });
    sidebar.on('hide', function () {
        console.log('Sidebar will be hidden.');
    });
    sidebar.on('hidden', function () {
        console.log('Sidebar is hidden.');
    });

    L.Control.Watermark = L.Control.extend({
        onAdd: function(map) {
            // var img = L.DomUtil.create('img');
            //
            // img.src = 'media/selogo1.png';
            // img.style.width = '60px';
            // return img;
            var content = L.DomUtil.create('div', 'aboutse');
            content.innerHTML = '<a target="_new" href="/"><img src="media/selogo1.png" width="50px"/></a><br><h4 style="background: white;"><a target="_new" href="/">Smart Emission</a></h4>';
            return content;
        },

        onRemove: function(map) {
            // Nothing to do here
        }
    });
    
    L.control.watermark = function(opts) {
        return new L.Control.Watermark(opts);
    };

    L.control.watermark({ position: 'topright' }).addTo(map);

    //sidebar.on(sidebar.getCloseButton(), 'click', function () {
    //    console.log('Close button clicked.');
    //});

});
