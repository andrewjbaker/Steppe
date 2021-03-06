/**
 * Renderer object.
 *
 * @author Andrew J. Baker
 */

/** @namespace Steppe */
var Steppe = (function(Steppe) {
    /** @class */
    Steppe.Renderer = function(canvas) {
        var _CANVAS_WIDTH        = 320,	// 320 pixels
            _CANVAS_HEIGHT       = 200,	// 200 pixels
            _ANGLE_OF_VIEW       = 60,	// 60 degrees
            _ONE_DEGREE_ANGLE    = 1 / _ANGLE_OF_VIEW * _CANVAS_WIDTH,
            _THIRTY_DEGREE_ANGLE = _ONE_DEGREE_ANGLE * 30,
            _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE = _ONE_DEGREE_ANGLE * 360,
            _ANGULAR_INCREMENT   = _ANGLE_OF_VIEW / _CANVAS_WIDTH,
            _DEGREES_TO_RADIANS  = Math.PI / 180,
            _FAKE_DEGREES_TO_RADIANS = (2 * Math.PI) /
                ((360 / _ANGLE_OF_VIEW) * _CANVAS_WIDTH),
            _RADIANS_TO_DEGREES  = 180 / Math.PI,
            _RADIANS_TO_FAKE_DEGREES = ((360 / _ANGLE_OF_VIEW) *
                _CANVAS_WIDTH) / (2 * Math.PI),
            _SCALE_FACTOR = 35,
            _CAMERA_Y     = 200,
            _DISTANCE     = 75,
            _MAXIMUM_ROW  = _CANVAS_HEIGHT + _CANVAS_HEIGHT / 2 - 1,
            _WATER_HEIGHT = 64;

        var _FASTEST   = 4,
            _DONT_CARE = 2,
            _NICEST    = 1;

        var _camera = { angle: 0, x: 0, y: _CAMERA_Y, z: 0 },
            _cosineLookupTable = [],
            _fogColor = 0xff7f7f7f,
            _framebuffer,
            _heightmap = [],
            _inverseDistortionLookupTable = [],
            _outOfBoundsHeightmap = [],
            _outOfBoundsTexturemap,
            _rayLengthLookupTable = [],
            _sineLookupTable = [],
            _sky,
            _skyData,
            _spriteList = [],
            _temporaryFramebuffer,
            _texturemap,
            _visibleSpriteList = [],
            _zBuffer = [];

        var _fog = false,		// disabled (default)
            _quality = _DONT_CARE,	// medium quality (default)
            _smooth = 0,		// disabled (default)
            _waterHeight = -1;		// disabled (default)

        /**
         * Blend two colours together using an alpha value.
         *
         * @param {number} firstColor First, or source, colour (ABGR).
         * @param {number} secondColor Second, or destination, colour (ABGR).
         * @param {number} alpha Alpha value in the range 0..255.
         * @return {number} Mixed colour (ABGR).
         */
        var _alphaBlend = function(firstColor, secondColor, alpha) {
            if (alpha < 0) {
                alpha = 0;
            } else if (alpha > 255) {
                alpha = 255;
            }

            var normalisedAlpha = alpha / 255,
                adjustedAlpha   = 1 - normalisedAlpha;

            var mixedRed   = ( firstColor        & 0xff) * normalisedAlpha | 0,
                mixedGreen = ((firstColor >>  8) & 0xff) * normalisedAlpha | 0,
                mixedBlue  = ((firstColor >> 16) & 0xff) * normalisedAlpha | 0;

            mixedRed   += Math.floor( (secondColor        & 0xff) *
                adjustedAlpha);
            mixedGreen += Math.floor(((secondColor >>  8) & 0xff) *
                adjustedAlpha);
            mixedBlue  += Math.floor(((secondColor >> 16) & 0xff) *
                adjustedAlpha);

            return mixedRed        |
                (mixedGreen <<  8) |
                (mixedBlue  << 16) | 0xff000000;
        };

        /**
         * Get a pixel from the out-of-bounds texturemap.
         *
         * @param {number} x The x-coordinate; must be in the range
         *                   0..out-of-bounds-texturemap-width - 1.
         * @param {number} y The y-coordinate; must be in the range
         *                   0..out-of-bounds-texturemap-height - 1.
         * @return {number} An integer composed of ABGR components for the
         *                  corresponding pixel.
         */
        var _getPixelFromOutOfBoundsTexturemap = function(x, y) {
            if (typeof _outOfBoundsTexturemap !== 'undefined') {
                var index = (y * 1024 + x) * 4;

                return _outOfBoundsTexturemap[index]          |
                    (_outOfBoundsTexturemap[index + 1] <<  8) |
                    (_outOfBoundsTexturemap[index + 2] << 16) | 0xff000000;
            } else {
                return 0xff7f7f7f;
            }
        };

        /**
         * Get a pixel from the sky canvas.
         *
         * @param {number} x The x-coordinate; should be in the range
         *                   0..sky-width - 1.
         * @param {number} y The y-coordinate; should be in the range
         *                   0..sky-height - 1.
         * @return {number} An integer composed of ABGR components for the
         *                  corresponding pixel.
         */
        var _getPixelFromSky = function(x, y) {
            var currentAngle = _camera.angle - _THIRTY_DEGREE_ANGLE;

            if (currentAngle < 0) {
                currentAngle += _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE;
            }

            if (y < 0) {
                y = 0;
            } else if (y >= 100) {
                y = 100 - 1;
            }

            var index = (y * 1920 + (currentAngle + x | 0) % 1920) * 4;

            return _skyData[index]          |
                (_skyData[index + 1] <<  8) |
                (_skyData[index + 2] << 16) | 0xff000000;
        };

        /**
         * Get a pixel from the texturemap.
         *
         * @param {number} x The x-coordinate; must be in the range
         *                   0..texturemap-width - 1.
         * @param {number} y The y-coordinate; must be in the range
         *                   0..texturemap-width - 1.
         * @return {number} An integer composed of ABGR components for the
         *                  corresponding pixel.
         */
        var _getPixelFromTexturemap = function(x, y) {
            if (typeof _outOfBoundsTexturemap !== 'undefined') {
                var index = (y * 1024 + x) * 4;

                return _texturemap[index]          |
                    (_texturemap[index + 1] <<  8) |
                    (_texturemap[index + 2] << 16) | 0xff000000;
            } else {
                return 0xffffffff;
            }
        };

        /**
         * Get the row at which a sprite should be rendered. This is a private
         * helper method.
         *
         * @param {number} x ...
         * @param {number} z ...
         * @param {number} ray ...
         * @return {number} ...
         */
        var _getRow = function(x, z, ray) {
            var cameraVectorX = Math.cos(_camera.angle * _ANGULAR_INCREMENT *
                _DEGREES_TO_RADIANS);
            var cameraVectorZ = Math.sin(_camera.angle * _ANGULAR_INCREMENT *
                _DEGREES_TO_RADIANS);

            var spriteVectorX = x - _camera.x;
            var spriteVectorZ = z - _camera.z;

            var vectorLength = Math.sqrt(spriteVectorX * spriteVectorX +
                spriteVectorZ * spriteVectorZ);

            var newVectorLength = vectorLength /
                _inverseDistortionLookupTable[ray];

            var y = Math.round(_DISTANCE * _camera.y / newVectorLength);
            var row = y + _CANVAS_HEIGHT - 1 - _camera.y;

            return row;
        };

        /**
         * Initialise the inverse distortion lookup table (for removing
         * fisheye).
         */
        var _initInverseDistortionLookupTable = function() {
            for (var angleOfRotation = 0;
                angleOfRotation < _THIRTY_DEGREE_ANGLE;
                ++angleOfRotation) {
                var angleOfRotationInRadians = angleOfRotation *
                    _ANGULAR_INCREMENT * _DEGREES_TO_RADIANS;

                _inverseDistortionLookupTable[angleOfRotation +
                    _THIRTY_DEGREE_ANGLE] = 1 /
                    Math.cos(angleOfRotationInRadians);

                var cosine = Math.cos(angleOfRotationInRadians);
                if (cosine !== 0) {
                    _inverseDistortionLookupTable[
                        _THIRTY_DEGREE_ANGLE - angleOfRotation] = 1 / cosine;
                }
            }

            _inverseDistortionLookupTable[0]   = 2;
            _inverseDistortionLookupTable[160] = 1;
        };

        /**
         * Initialise (or recalculate) the ray-length lookup table.
         *
         * @param {number} distance The distance from the camera to the
         *                          projection plane.
         */
        var _initRayLengthLookupTable = function(distance) {
            for (var y = 200; y <= 300; ++y) {
                _rayLengthLookupTable[y] = [];

                for (var ray = 1; ray < _CANVAS_WIDTH; ++ray) {
                    for (var row = 0; row <= _MAXIMUM_ROW; ++row) {
                        var invertedRow = _CANVAS_HEIGHT - 1 - row;

                        var rayLength = _inverseDistortionLookupTable[ray] *
                            ((distance * y) / (y - invertedRow));

                        _rayLengthLookupTable[y][row * _CANVAS_WIDTH + ray] =
                            rayLength;
                    }
                }
            }
        };

        /**
         * Initialise the sine and cosine lookup tables.
         */
        var _initSineAndCosineLookupTables = function() {
            for (var angleOfRotation = 0;
                angleOfRotation < _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE;
                ++angleOfRotation) {
                var angleOfRotationInRadians = angleOfRotation *
                    _ANGULAR_INCREMENT * _DEGREES_TO_RADIANS;

                _sineLookupTable[angleOfRotation]   = Math.sin(
                    angleOfRotationInRadians);
                _cosineLookupTable[angleOfRotation] = Math.cos(
                    angleOfRotationInRadians);
            }
        };

        /**
         * Render the terrain (landscape).
         *
         * @param {number} initialAngle ...
         */
        var _renderFrontToBack = function(initialAngle) {
            var currentAngle = initialAngle;

            var framebufferImageData = _temporaryFramebuffer.createImageData(
                320, 200);
            var framebufferData      = framebufferImageData.data;

            for (var ray = _quality; ray < _CANVAS_WIDTH; ray += _quality) {
                var previousTop = _MAXIMUM_ROW;

                for (var row = _MAXIMUM_ROW; row >= 0; --row) {
                    var rayLength = _rayLengthLookupTable[_camera.y][
                        row * 320 + ray];

                    var rayX = _camera.x + rayLength *
                        _cosineLookupTable[currentAngle] | 0,
                        rayZ = _camera.z + rayLength *
                        _sineLookupTable[currentAngle]   | 0;

                    var u = rayX % 1024;
                    var v = rayZ % 1024;

                    var height;
                    if ((rayX < 1024 || rayX >= 1024 + 1024 ||
                        rayZ < 1024 || rayZ >= 1024 + 1024) &&
                        _outOfBoundsHeightmap.length > 0) {
                        height = _outOfBoundsHeightmap[v * 1024 + u];
                    } else {
                        height = _heightmap[v * 1024 + u];
                    }

                    var scale = height * _SCALE_FACTOR / (rayLength + 1) | 0;

                    var top    = (_CANVAS_HEIGHT / 2) -
                        (_camera.y - _CANVAS_HEIGHT) + row - scale,
                        bottom = top + scale;

                    if (top < previousTop) {
                        bottom = previousTop;
                        previousTop = top;

                        var color = 0xff000000;

                        var texel;
                        if (rayX < 1024 || rayX >= 1024 + 1024 ||
                            rayZ < 1024 || rayZ >= 1024 + 1024) {
                            texel =
                                _getPixelFromOutOfBoundsTexturemap(u, v);

                            color = texel;
                        } else {
                            if (height < _waterHeight) {
                                var data = _getPixelFromSky(ray,
                                    200 - top);

                                texel =
                                    _getPixelFromTexturemap(u, v);

                                var mixedColor = _alphaBlend(data,
                                    texel, (_waterHeight - height) /
                                    _waterHeight * 255 * 2 | 0);

                                texel = mixedColor;

                                height = _waterHeight;

                                color = texel;
                            } else {
                                texel =
                                    _getPixelFromTexturemap(u, v);

                                color = texel;
                            }
                        }

                        if (_fog) {
                            var foggedTexel = _alphaBlend(texel,
                                _fogColor, row / 100 * 255 | 0);

                            color = foggedTexel;
                        }

                        if (bottom > 199) {
                            bottom = 199;
                        }

                        var qualityMultipliedByFour = _quality * 4;

                        var index, i, j;
                        if (ray > _quality) {
                            // Not the left-most ray...
                            index =
                                (top * (framebufferImageData.width * 4)) +
                                (ray * 4);

                            var red   =  color        & 0xff,
                                green = (color >>  8) & 0xff,
                                blue  = (color >> 16) & 0xff;

                            for (j = 0; j < bottom - top + 1; ++j) {
                                for (i = 0; i < _quality; ++i) {
                                    framebufferData[index++] = red;
                                    framebufferData[index++] = green;
                                    framebufferData[index++] = blue;
                                    framebufferData[index++] = 0xff;
                                }

                                index += (framebufferImageData.width * 4) -
                                    qualityMultipliedByFour;
                            }
                        } else {
                            // Left-most ray: we don't cast rays for column 0!
                            index =
                                (top * (framebufferImageData.width * 4)) +
                                (ray * 4);

                            red   =  color        & 0xff;
                            green = (color >>  8) & 0xff;
                            blue  = (color >> 16) & 0xff;

                            for (j = 0; j < bottom - top + 1; ++j) {
                                for (i = 0; i < _quality; ++i) {
                                    framebufferData[index -
                                        qualityMultipliedByFour]     = red;
                                    framebufferData[index -
                                        qualityMultipliedByFour + 1] = green;
                                    framebufferData[index -
                                        qualityMultipliedByFour + 2] = blue;
                                    framebufferData[index -
                                        qualityMultipliedByFour + 3] = 0xff;

                                    framebufferData[index++] = red;
                                    framebufferData[index++] = green;
                                    framebufferData[index++] = blue;
                                    framebufferData[index++] = 0xff;
                                }

                                index += (framebufferImageData.width * 4) -
                                    qualityMultipliedByFour;
                            }
                        }
                    }
                }

                currentAngle += _quality;
                if (currentAngle >= _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE) {
                    currentAngle = 0;
                }
            }

            _temporaryFramebuffer.putImageData(framebufferImageData, 0, 0);

            _framebuffer.drawImage(_temporaryFramebuffer.canvas,
                0, 0 - _smooth,
                _temporaryFramebuffer.canvas.width,
                _temporaryFramebuffer.canvas.height);
        };

        /**
         * Render the 360-degree panoramic sky based on the camera's angle
         * of rotation.
         */
        var _renderSky = function() {
            var angleOfRotation = _camera.angle - _THIRTY_DEGREE_ANGLE;

            if (angleOfRotation < 0) {
                angleOfRotation += _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE;
            }

            angleOfRotation |= 0; 

            var skyWidth  = _sky.width;
            var skyHeight = (_CANVAS_HEIGHT / 2) -
                (_camera.y - _CANVAS_HEIGHT);

            if (skyHeight > _sky.height) {
                skyHeight = _sky.height;
            }

            var sy = _camera.y - _CANVAS_HEIGHT;

            if (sy < 0) {
                sy = 0;
            }

            if (angleOfRotation + 320 <= skyWidth) {
                _framebuffer.drawImage(_sky, angleOfRotation, sy, 320,
                    skyHeight, 0, 0, 320, skyHeight);
            } else {
                _framebuffer.drawImage(_sky, angleOfRotation, sy,
                    skyWidth - angleOfRotation, skyHeight, 0, 0,
                    skyWidth - angleOfRotation, skyHeight);
                _framebuffer.drawImage(_sky, 0, sy,
                    320 - (skyWidth - angleOfRotation),
                    skyHeight, skyWidth - angleOfRotation, 0,
                    320 - (skyWidth - angleOfRotation), skyHeight);
            }

            if (_fog) {
                var skyContext = _sky.getContext('2d');

                var skyGradient = skyContext.createLinearGradient(0, 0, 0,
                    skyHeight - 1);
                skyGradient.addColorStop(0, 'rgba(' +
                    ( _fogColor        & 0xff) + ', ' +
                    ((_fogColor >>  8) & 0xff) + ', ' +
                    ((_fogColor >> 16) & 0xff) + ', ' +
                    (1 - (1 / (100 / skyHeight))) + ')');
                skyGradient.addColorStop(1, 'rgba(' +
                    ( _fogColor        & 0xff) + ', ' +
                    ((_fogColor >>  8) & 0xff) + ', ' +
                    ((_fogColor >> 16) & 0xff) + ', 1)');

                _framebuffer.fillStyle = skyGradient;
                _framebuffer.fillRect(0, 0, 320, skyHeight);
            }
        };

        /**
         * Render visible sprites.
         */
        var _renderSprites = function() {
            var spriteCanvas = document.createElement('canvas');
            spriteCanvas.width  = 1;
            spriteCanvas.height = 1;

            var spriteContext = spriteCanvas.getContext('2d');

            // For each visible sprite...
            for (var i = 0; i < _visibleSpriteList.length; ++i) {
                // If the current sprite has been removed...
                if (typeof _visibleSpriteList[i] === 'undefined') {
                    // Move to the next sprite.
                    continue;
                }

                var sprite = _visibleSpriteList[i];

                if (_fog) {
                    spriteCanvas.width = sprite.image.width;
                    spriteCanvas.height = sprite.image.height;

                    spriteContext.save();

                    spriteContext.drawImage(sprite.image, 0, 0);
                    spriteContext.globalCompositeOperation = 'source-atop';
                    spriteContext.fillStyle = 'rgba(' +
                        ( _fogColor        & 0xff) + ', ' +
                        ((_fogColor >>  8) & 0xff) + ', ' +
                        ((_fogColor >> 16) & 0xff) + ', ' +
                        (1 - (sprite.y + sprite.height) / 200) + ')';
                    spriteContext.fillRect(0, 0, spriteCanvas.width,
                        spriteCanvas.height);

                    // Draw the sprite (canvas).
                    _framebuffer.drawImage(
                        spriteCanvas,
                        sprite.x,
                        sprite.y - _smooth,
                        sprite.width,
                        sprite.height);

                    spriteContext.restore();
                } else {
                    // Draw the sprite.
                    _framebuffer.drawImage(
                        sprite.image,
                        sprite.x,
                        sprite.y - _smooth,
                        sprite.width,
                        sprite.height);
                }

                // Remove the sprite from the list of visible sprites.
                delete _visibleSpriteList[i];
            }

            delete spriteContext;
            delete spriteCanvas;
        };

        /**
         * Sort the list of currently visible sprites.
         */
        var _sortVisibleSpriteList = function() {
            var length = _visibleSpriteList.length;

            for (var i = 0; i < length - 1; ++i) {
                for (var j = i + 1; j < length; ++j) {
                    if (_visibleSpriteList[j].vectorLength >
                        _visibleSpriteList[i].vectorLength) {
                        var temp = _visibleSpriteList[i];
                        _visibleSpriteList[i] = _visibleSpriteList[j];
                        _visibleSpriteList[j] = temp;
                    }
                }
            }
        };

        if (arguments.length > 1) {
            throw('Too many arguments passed to constructor');
        }

        if (canvas.width !== _CANVAS_WIDTH) {
            throw('Canvas width not equal to ' + _CANVAS_WIDTH);
        }
        if (canvas.height !== _CANVAS_HEIGHT) {
            throw('Canvas height not equal to ' + _CANVAS_HEIGHT);
        }

        _framebuffer = canvas.getContext('2d');

        var temporaryFramebufferCanvas    = document.createElement('canvas');
        temporaryFramebufferCanvas.width  = canvas.width;
        temporaryFramebufferCanvas.height = canvas.height;

        _temporaryFramebuffer = temporaryFramebufferCanvas.getContext('2d');

        _initSineAndCosineLookupTables();
        _initInverseDistortionLookupTable();
        _initRayLengthLookupTable(_DISTANCE);

        return {
            /**
             * Add a 2D sprite, at the specified world coords, to the sprite
             * list.
             *
             * @param {HTMLImageElement} image The 2D sprite as an image.
             * @param {number} x The x-coordinate in world space.
             * @param {number} y The y-coordinate in world space.
             * @param {number} z The z-coordinate in world space.
             * @return {Renderer} This (chainable).
             */
            addSprite: function(image, x, y, z) {
                if ( !(image instanceof HTMLImageElement)) {
                    throw('Invalid image: not an instance of HTMLImageElement');
                }
                if (typeof(x) != 'number') {
                    throw('Invalid x: not a number');
                }
                if (typeof(y) != 'number') {
                    throw('Invalid y: not a number');
                }
                if (typeof(z) != 'number') {
                    throw('Invalid z: not a number');
                }

                if (x < 1024 || x >= 1024 + 1024) {
                    throw('Invalid x: must be in the range 1024..2047');
                }
                if (y < 0 || y >= 1024) {
                    throw('Invalid y: must be in the range 0..1023');
                }
                if (z < 1024 || z >= 1024 + 1024) {
                    throw('Invalid z: must be in the range 1024..2047');
                }

                _spriteList.push({
                    image: image,
                    x: x,
                    y: y & 1023,
                    z: z
                });

                return this;
            },

            /**
             * Disable a Steppe capability.
             *
             * @param {string} capability Specifies a string indicating a
             *                            Steppe capability; 'fog',
             *                            'reflection-map' and 'smooth' are
             *                            currently implemented.
             * @return {Renderer} This (chainable).
             */
            disable: function(capability) {
                if (capability === 'fog') {
                    _fog = false;
                } else if (capability === 'reflection-map') {
                    _waterHeight = -1;
                } else if (capability === 'smooth') {
                    _smooth = 0;
                } else {
                    throw("Can't disable unknown capability");
                }

                return this;
            },

            /**
             * Enable a Steppe capability.
             *
             * @param {string} capability Specifies a string indicating a
             *                            Steppe capability; 'fog',
             *                            'reflection-map' and 'smooth' are
             *                            currently implemented.
             * @return {Renderer} This (chainable).
             */
            enable: function(capability) {
                if (capability === 'fog') {
                    _fog = true;
                } else if (capability === 'reflection-map') {
                    _waterHeight = _WATER_HEIGHT;
                } else if (capability === 'smooth') {
                    _smooth = 0.5;
                } else {
                    throw("Can't enable unknown capability");
                }

                return this;
            },

            /**
             * Get the current camera.
             *
             * @return {object} An object composed of an angle-of-rotation (in
             *                  degrees about the y-axis) and a 3D point in
             *                  world space.
             */
            getCamera: function() {
                return {
                    angle: _camera.angle /
                        _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE * 360 +
                        0.5 | 0,
                    x:     _camera.x,
                    y:     _camera.y,
                    z:     _camera.z
                };
            },

            /**
             * Get the height (from the heightmap) of a single unit of terrain,
             * in world space.
             *
             * @param {number} x The x-coordinate of the unit of terrain.
             * @param {number} z The z-coordinate of the unit of terrain.
             * @return {number} The corresponding y-coordinate of the specified
             *                  unit of terrain.
             */
            getHeight: function(x, z) {
                if (typeof(x) != 'number') {
                    throw('Invalid x: not a number');
                }
                if (typeof(z) != 'number') {
                    throw('Invalid z: not a number');
                }

                if (x < 1024 || x >= 1024 + 1024) {
                    throw('Invalid x: must be in the range 1024..2047');
                }
                if (z < 1024 || z >= 1024 + 1024) {
                    throw('Invalid z: must be in the range 1024..2047');
                }

                var u = x & 1023;
                var v = z & 1023;

                return _heightmap[v * 1024 + u];
            },

            /**
             * Test whether a capability is enabled.
             *
             * @param {string} capability Specifies a string indicating a
             *                            Steppe capability; 'smooth' and
             *                            'reflection-map' are currently
             *                            implemented.
             * @return {boolean} Returns true if capability is an enabled
             *                   capability and returns false otherwise.
             */
            isEnabled: function(capability) {
                if (capability === 'fog') {
                    return _fog;
                } else if (capability === 'reflection-map') {
                    return (_waterHeight > -1);
                } else if (capability === 'smooth') {
                    return (_smooth === 0.5);
                }
                throw('Unknown capability');
            },

            /**
             * Render the terrain (landscape) including the sky and any visible
             * sprites.
             */
            render: function() {
                /*
                 * 1. Construct a list of visible sprites; sprites are visible
                 *    where they fall within the -30..30 (60-degree) horizontal
                 *    field-of-view based on the direction that the camera is
                 *    pointing in.
                 * 2. For each visible sprite, determine its projected 2D
                 *    coords (x and y) and its scaled width and height based on
                 *    distance from the camera. The y coord corresponds to the
                 *    bottom of the sprite and the x coord is the centre of the
                 *    width of the sprite.
                 * 3. After drawing each row of terrain, draw any sprites where
                 *    the sprite's 'projected' row equals the current row.
                 *    Remove the sprite from the list of visible sprites.
                 * 4. Rinse and repeat.
                 */

                // Fill the upper region of the framebuffer with the
                // fog-colour.
                _framebuffer.fillStyle = '#7f7f7f';	// XXX ?!
                _framebuffer.fillRect(0, 100, 320, 25);

                _renderSky();

                // Empty the list of visible sprites.
                _visibleSpriteList.length = 0;

                if (_spriteList.length > 0) {
                    // Calculate the unit vector of the camera.
                    var cameraVectorX = Math.cos(_camera.angle *
                        _ANGULAR_INCREMENT * _DEGREES_TO_RADIANS);
                    var cameraVectorZ = Math.sin(_camera.angle *
                        _ANGULAR_INCREMENT * _DEGREES_TO_RADIANS);

                    // For each sprite...
                    for (var i = 0; i < _spriteList.length; ++i) {
                        var sprite = _spriteList[i];

                        // Calculate the vector of the sprite.
                        var spriteVectorX = sprite.x - _camera.x,
                            spriteVectorZ = sprite.z - _camera.z;

                        // Calculate the magnitude (length of the vector) to
                        // determine the distance from the camera to the
                        // sprite.
                        var vectorLength = Math.sqrt(
                            spriteVectorX * spriteVectorX +
                            spriteVectorZ * spriteVectorZ);

                        // If the distance from the camera to the sprite is
                        // outside the viewing frustum...
                        if (vectorLength > 400) {
                            // Move to the next sprite.
                            continue;
                        }

                        // Normalise the sprite vector to become the unit
                        // vector.
                        spriteVectorX /= vectorLength;
                        spriteVectorZ /= vectorLength;

                        // Calculate the dot product of the camera and sprite
                        // vectors.
                        var dotProduct = cameraVectorX * spriteVectorX +
                            cameraVectorZ * spriteVectorZ;

                        // If the dot product is negative...
                        if (dotProduct < 0) {
                            // The sprite is behind the camera, so clearly not
                            // in view. Move to the next sprite.
                            continue;
                        }

                        // Calculate the angle (theta) between the camera vector
                        // and the sprite vector.
                        var theta = Math.acos(dotProduct);

                        // If the angle (theta) is less than or equal to 30
                        // degrees...
                        // NOTE: We do NOT need to check the lower bound (-30
                        // degrees) because theta will /never/ be negative.
                        if (theta <= _THIRTY_DEGREE_ANGLE *
                            _FAKE_DEGREES_TO_RADIANS) {
                            var scale = _SCALE_FACTOR / (vectorLength + 1);

                            // Scale the projected sprite.
                            var width  = scale * sprite.image.width  | 0;
                            var height = scale * sprite.image.height | 0;

                            // Calculate the cross product. The cross product
                            // differs from the dot product in a crucial way:
                            // the result is *signed*!
                            var crossProduct = cameraVectorX * spriteVectorZ -
                                spriteVectorX * cameraVectorZ;

                            // Calculate the projected x coord relative to the
                            // horizontal centre of the canvas. We add or
                            // subtract the value dependent on the sign of the
                            // cross product.
                            var x;
                            if (crossProduct < 0) {
                                x = _CANVAS_WIDTH / 2 - theta *
                                    _RADIANS_TO_FAKE_DEGREES | 0;
                            } else {
                                x = _CANVAS_WIDTH / 2 + theta *
                                    _RADIANS_TO_FAKE_DEGREES | 0;
                            }

                            // Calculate the 3D coords of the sprite.
                            var spriteX = sprite.x,
                                spriteY = _heightmap[((sprite.z % 1024) *
                                    1024) + (sprite.x % 1024)],
                                spriteZ = sprite.z;

                            var row = _getRow(spriteX, spriteZ, x);

                            // Centre the scaled sprite.
                            x -= width / 2;

                            var rayX = spriteX,
                                rayZ = spriteZ;

                            var u = rayX % 1024,
                                v = rayZ % 1024;

                            var projectedHeight;
                            if ((rayX < 1024 || rayX >= 1024 + 1024 ||
                                rayZ < 1024 || rayZ >= 1024 + 1024) &&
                                _outOfBoundsHeightmap.length > 0) {
                                projectedHeight = _outOfBoundsHeightmap[
                                    v * 1024 + u];
                            } else {
                                projectedHeight = _heightmap[v * 1024 + u];
                            }

                            var projectedScale = projectedHeight * scale;

                            var top = (_CANVAS_HEIGHT / 2) -
                                (_camera.y - _CANVAS_HEIGHT) + row -
                                projectedScale,
                                bottom = top + projectedScale;

                            // Add the projected sprite to the list of visible
                            // sprites.
                            _visibleSpriteList.push({
                                height:       height,
                                image:        sprite.image,
                                row:          bottom | 0,
                                vectorLength: vectorLength,
                                width:        width,
                                x:            x | 0,
                                y:            top - height | 0
                            });
                        }
                    }
                }

                _sortVisibleSpriteList();
//                for (var k = 0; k < _visibleSpriteList.length; ++k) {
//                    console.log(_visibleSpriteList[k].vectorLength);
//                }

                var initialAngle = _camera.angle - _THIRTY_DEGREE_ANGLE;

                if (initialAngle < 0) {
                    initialAngle += _THREE_HUNDRED_AND_SIXTY_DEGREE_ANGLE;
                }

                initialAngle |= 0;

//                var date = new Date();
//                var startTime = date.getTime();

                // Render the terrain front-to-back.
                _renderFrontToBack(initialAngle);

                // If there are sprites in view...
                if (_visibleSpriteList.length > 0) {
                    _renderSprites();
                }

//                var date2 = new Date();
//                var endTime = date2.getTime();
//                console.log(endTime - startTime);
            },

            /**
             * Set the current camera.
             *
             * @param {object} camera The object representing the current
             *                        camera.
             * @return {Renderer} This (chainable).
             */
            setCamera: function(camera) {
                if (typeof(camera) != 'object') {
                    throw('Invalid camera: not an object');
                }

                _camera.angle = (typeof camera.angle === 'number') ?
                    (Math.abs(~~(camera.angle + 0.5)) % 360 /
                    _ANGLE_OF_VIEW * 320) : (_camera.angle);
                _camera.x = (typeof camera.x === 'number') ?
                    (~~(camera.x + 0.5)) : (_camera.x);
                if (typeof camera.y === 'number' && camera.y >= 200 &&
                    camera.y <= 300) {
                    _camera.y = ~~(camera.y + 0.5);
                }
                _camera.z = (typeof camera.z === 'number') ?
                    (~~(camera.z + 0.5)) : (_camera.z);

                return this;
            },

            /**
             * Set the fog colour.
             *
             * @param {string} cssColor ...
             * @return {Renderer} This (chainable).
             */
            setFogColor: function(cssColor) {
                if ( !_fog) {
                    throw('Capability not enabled');
                }

                var re = /#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/;
                var matches = re.exec(cssColor);

                if (matches.length != 4) {
                    throw('Invalid cssColor: must be in fully-qualified ' +
                        'hexadecimal CSS format (#rrggbb)');
                }

                var red   = matches[1],
                    green = matches[2],
                    blue  = matches[3];

                _fogColor = ( parseInt(red,   16)        |
                             (parseInt(green, 16) <<  8) |
                             (parseInt(blue,  16) << 16) | 0xff000000);

                return this;
            },

            /**
             * Set the heightmap to use for terrain rendering.
             *
             * @param {array} heightmap The heightmap canvas as an array of
             *                          values in the range 0..255.
             * @return {Renderer} This (chainable).
             */
            setHeightmap: function(heightmap) {
                if ( !(heightmap instanceof Array)) {
                    throw('Invalid heightmap: not an array');
                }

                if (heightmap.length != 1024 * 1024) {
                    throw('Invalid heightmap: number of array elements ' +
                        'incorrect');
                }

                _heightmap = heightmap;

                return this;
            },

            /**
             * Set the out-of-bounds heightmap.
             *
             * @param {array} outOfBoundsHeightmap The out-of-bounds heightmap
             *                                     canvas as an array.
             * @return {Renderer} This (chainable).
             */
            setOutOfBoundsHeightmap: function(outOfBoundsHeightmap) {
                if ( !(outOfBoundsHeightmap instanceof Array)) {
                    throw('Invalid outOfBoundsHeightmap: not an array');
                }

                if (outOfBoundsHeightmap.length != 1024 * 1024) {
                    throw('Invalid outOfBoundsHeightmap: number of array ' +
                        'elements incorrect');
                }

                _outOfBoundsHeightmap = outOfBoundsHeightmap;

                return this;
            },

            /**
             * Set the out-of-bounds texturemap.
             *
             * @param {HTMLCanvasElement} outOfBoundsTexturemapCanvas The
             *                            out-of-bounds texturemap canvas.
             * @return {Renderer} This (chainable).
             */
            setOutOfBoundsTexturemap: function(
                outOfBoundsTexturemapCanvas) {
                if ( !(outOfBoundsTexturemapCanvas instanceof
                    HTMLCanvasElement)) {
                    throw('Invalid outOfBoundsTexturemapCanvas: not an ' +
                        'instance of HTMLCanvasElement');
                }

                if (outOfBoundsTexturemapCanvas.width != 1024) {
                    throw('outOfBoundsTexturemapCanvas width not equal ' +
                        'to 1024');
                }
                if (outOfBoundsTexturemapCanvas.height != 1024) {
                    throw('outOfBoundsTexturemapCanvas height not equal ' +
                        'to 1024');
                }

                _outOfBoundsTexturemap =
                    outOfBoundsTexturemapCanvas.getContext('2d')
                    .getImageData(0, 0, outOfBoundsTexturemapCanvas.width,
                    outOfBoundsTexturemapCanvas.height).data;

                return this;
            },

            /**
             * Set render quality.
             *
             * @param {string} quality Specifies a string indicating the
             *                         render quality from 'low', through
             *                         'medium', to 'high'.
             * @return {Renderer} This (chainable).
             */
            setQuality: function(quality) {
                if (quality === 'medium') {
                    _quality = _DONT_CARE;
                } else if (quality === 'low') {
                    _quality = _FASTEST;
                } else if (quality === 'high') {
                    _quality = _NICEST;
                } else {
                    throw("Invalid quality: must be 'low', 'medium', " +
                        "or 'high'");
                }

                return this;
            },

            /**
             * Set the canvas to use for 360-degree panoramic sky.
             *
             * @param {HTMLCanvasElement} skyCanvas The sky canvas; must be
             *                                      1920x100.
             * @return {Renderer} This (chainable).
             */
            setSky: function(skyCanvas) {
                if ( !(skyCanvas instanceof HTMLCanvasElement)) {
                    throw('Invalid skyCanvas: not an instance of ' +
                        'HTMLCanvasElement');
                }

                if (skyCanvas.width != 1920) {
                    throw('skyCanvas width not equal to 1920');
                }
                if (skyCanvas.height != 100) {
                    throw('skyCanvas height not equal to 100');
                }

                _sky = skyCanvas;
                _skyData = skyCanvas.getContext('2d').getImageData(0, 0,
                    skyCanvas.width, skyCanvas.height).data;

                return this;
            },

            /**
             * Set the texturemap.
             *
             * @param {HTMLCanvasElement} texturemapCanvas The texturemap
             *                                             canvas.
             * @return {Renderer} This (chainable).
             */
            setTexturemap: function(texturemapCanvas) {
                if ( !(texturemapCanvas instanceof HTMLCanvasElement)) {
                    throw('Invalid texturemapCanvas: not an instance of ' +
                        'HTMLCanvasElement');
                }

                if (texturemapCanvas.width != 1024) {
                    throw('texturemapCanvas width not equal to 1024');
                }
                if (texturemapCanvas.height != 1024) {
                    throw('texturemapCanvas height not equal to 1024');
                }

                _texturemap = texturemapCanvas.getContext('2d')
                    .getImageData(0, 0, texturemapCanvas.width,
                    texturemapCanvas.height).data;

                return this;
            },

            /**
             * Set height of the reflection-mapped water.
             *
             * @param {number} height Globally-defined height of the
             *                        reflection-mapped water. It must be
             *                        in the range 0..255.
             * @return {Renderer} This (chainable).
             */
            setWaterHeight: function(height) {
                if (_waterHeight == -1) {
                    throw('Capability not enabled');
                }

                if (typeof(height) != 'number') {
                    throw('Invalid height: not a number');
                }

                if (height < 0 || height > 255) {
                    throw('Invalid height: must be in the range 0..255');
                }

                _waterHeight = height;

                return this;
            }
        };
    };

    return Steppe;
} (Steppe || { }) );
