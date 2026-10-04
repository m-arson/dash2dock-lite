uniform float red;
uniform float green;
uniform float blue;
uniform float blend;

vec3 greyscale(vec3 color, float str) {
    float g = dot(color, vec3(0.299, 0.587, 0.114));
    return mix(color, vec3(g), str);
}

vec3 greyscale(vec3 color) {
    return greyscale(color, 1.0);
}

vec4 d2da_effect(vec4 c) {
    vec3 pix_color = greyscale(c.rgb);
    vec3 color = vec3(red * c.a, green * c.a, blue * c.a);
    return vec4(mix(pix_color, color, blend), c.a);
}
